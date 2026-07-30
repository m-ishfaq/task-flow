-- 0010 — attachments (PLAN.md §7, §8.4)
--
-- The upload pipeline from §8.4, expressed as a state machine on one column:
--
--   presigned PUT with type and size pinned in the signature
--        -> magic-byte verification on confirm
--        -> ClamAV scan
--        -> only then flagged downloadable
--
-- `status` IS that pipeline, and the whole security argument of this table is
-- that `presignDownload` is only ever called for rows reading 'clean'. A file
-- sits in object storage from the moment the browser finishes the PUT; what
-- this table controls is whether anyone is ever handed a URL to it.
--
-- Four things here are deliberate and easy to undo by accident.
--
-- 1. THE DEFAULT STATUS IS 'pending', AND THERE IS NO WAY TO INSERT 'clean'.
--    A row is created at presign time, before any bytes exist. Every later
--    state is written by the confirm path, so a client that never calls confirm
--    leaves a pending row and an orphaned object — which a retention job
--    collects — rather than a downloadable file nobody checked.
--
-- 2. `storage_key` IS SERVER-GENERATED AND UNIQUE.
--    A client-supplied key is a path traversal and an overwrite of someone
--    else's object in one field. The UNIQUE index is the backstop: if the key
--    generator ever produced a collision, the second upload fails rather than
--    silently replacing the first tenant's file.
--
-- 3. THERE IS NO FOREIGN KEY TO CARDS.
--    Attachments hang off cards today and off messages and pages from Phase 5.
--    `(parent_type, parent_id)` is polymorphic for that reason, and the same
--    reasoning as authz.relationship_tuples applies: the service that owns the
--    parent is responsible for cleanup, and a dangling attachment grants access
--    to nothing because the parent lookup fails first.
--
-- 4. `size_bytes` IS bigint AND IS RECORDED TWICE.
--    `declared_bytes` is what the client said at presign — pinned into the
--    signature, so storage itself rejects a larger body. `size_bytes` is what
--    HEAD reported afterwards. Keeping both means "the client lied" is a
--    detectable state rather than an assumption.

CREATE TABLE platform.attachments (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- Polymorphic parent. No foreign key — see note 3.
  parent_type     text        NOT NULL,
  parent_id       uuid        NOT NULL,

  -- Server-generated. Never any part of it supplied by a client.
  storage_key     text        NOT NULL,

  -- The name to show and to send in Content-Disposition. Stored as given and
  -- escaped at use; sanitizing on the way in loses information and still leaves
  -- every consumer needing to escape.
  filename        text        NOT NULL,

  -- What the client declared at presign. Pinned into the upload signature, so
  -- storage rejects a body sent with a different type.
  content_type    text        NOT NULL,
  declared_bytes  bigint      NOT NULL,

  -- What HEAD reported after the upload landed. Null until confirm runs.
  size_bytes      bigint,

  -- The pipeline. See the top of this file.
  status          text        NOT NULL DEFAULT 'pending',

  -- What the scanner said — the signature name for an infected file, or a
  -- reason for a rejection. Kept for the audit trail: "which file, and what was
  -- in it" is the first question after a detection.
  scan_result     text,
  scanned_at      timestamptz,

  uploaded_by     uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT attachments_parent_type_valid
    CHECK (parent_type IN ('card', 'comment', 'message', 'page')),

  CONSTRAINT attachments_status_valid
    CHECK (status IN ('pending', 'scanning', 'clean', 'infected', 'rejected')),

  CONSTRAINT attachments_filename_present CHECK (length(btrim(filename)) > 0),
  CONSTRAINT attachments_filename_length  CHECK (length(filename) <= 255),

  -- A filename containing a path separator or a NUL is either an attack or a
  -- broken client. It never reaches the storage key — that is generated — but
  -- it does reach Content-Disposition and a user's filesystem on download.
  CONSTRAINT attachments_filename_safe
    CHECK (filename !~ '[/\\]' AND position(E'\\000' in filename) = 0),

  CONSTRAINT attachments_declared_positive CHECK (declared_bytes > 0),
  CONSTRAINT attachments_size_positive     CHECK (size_bytes IS NULL OR size_bytes >= 0),

  -- A scanned row must say when. Without this, 'clean' with a null scanned_at
  -- is representable, and that is precisely the row a bug would produce:
  -- downloadable, with no evidence anything looked at it.
  CONSTRAINT attachments_scan_recorded
    CHECK (
      (status IN ('pending', 'scanning') AND scanned_at IS NULL)
      OR (status IN ('clean', 'infected', 'rejected') AND scanned_at IS NOT NULL)
    )
);

-- See note 2. Also the lookup used when storage reports an object and we need
-- to know which row owns it.
CREATE UNIQUE INDEX attachments_storage_key_key ON platform.attachments (storage_key);

-- The card detail panel's query: every live attachment on one parent.
CREATE INDEX attachments_parent_idx
  ON platform.attachments (org_id, parent_type, parent_id)
  WHERE deleted_at IS NULL;

-- The retention sweep: rows that were presigned and never confirmed.
CREATE INDEX attachments_pending_idx
  ON platform.attachments (created_at)
  WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
-- --------------------------------------------------------------------------
ALTER TABLE platform.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.attachments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attachments_tenant_isolation ON platform.attachments;
CREATE POLICY attachments_tenant_isolation ON platform.attachments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
