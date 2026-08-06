-- 0025 — docs: comments, suggestions, backlinks, and the taskflow_backlinks
-- consumer role (PLAN.md §7.2, §10.6; ai/phase-6-docs.md §3.6, §3.10, §4,
-- Wave 3)
--
-- Four things here are load-bearing.
--
-- 1. COMMENT AND SUGGESTION ANCHORS ARE OPAQUE bytea, NEVER A CHARACTER RANGE.
--    §3.6: "storing a plain character offset would detach the comment from
--    its text the moment anyone edits anything before that offset." Both
--    tables store a serialized Yjs `RelativePosition` pair (anchor_from,
--    anchor_to) instead — bytes only the browser's live `Y.Doc` can resolve
--    back into an absolute position, via `Y.createAbsolutePositionFromRelativePosition`.
--    Neither this migration nor any server process ever decodes what the
--    bytes MEAN (which character they point at); `apps/api` only checks that
--    they are STRUCTURALLY a valid encoded RelativePosition
--    (`apps/api/src/docs/anchor.ts`), the same "shape-only" trust boundary
--    `docs.yjs_updates.data` already established in migration 0024.
--
-- 2. BACKLINKS ARE COMPUTED BY apps/api, NEVER BY apps/collab.
--    The spec's own §3.10 describes backlink indexing running "at the same
--    save-boundary validation pass" apps/collab already performs — which
--    would mean handing the single write-exception socket process (§6.1: two
--    tables, INSERT/SELECT/DELETE, nothing else) a THIRD table to write, for
--    a feature with no latency requirement. Reviewed and rejected before
--    writing this migration: widening `taskflow_collab`'s grant is the one
--    thing this whole design has spent two migrations keeping narrow, and
--    "the backlink list is a few seconds stale" is a cost worth paying to
--    avoid it. Below, `taskflow_collab`'s grants are UNCHANGED — grep this
--    file for the string and there is exactly one match, the one already in
--    migration 0024.
--
-- 3. THE TRIGGER THIS DOES NOT HAVE: no PL/pgSQL, no SECURITY DEFINER.
--    The obvious way to notice "a page's content changed" without touching
--    apps/collab is an AFTER INSERT trigger on docs.page_versions that
--    fans out into a dispatch table — but a trigger fired by taskflow_collab's
--    own INSERT executes AS taskflow_collab (Postgres triggers run with the
--    INVOKING role's privileges unless the function is SECURITY DEFINER),
--    so making that work would need either granting taskflow_collab INSERT
--    on a fourth table anyway, or introducing this codebase's first-ever
--    SECURITY DEFINER function — a privilege-escalation mechanism nothing
--    here has needed before and not one to introduce quietly inside a
--    migration whose whole point is minimizing a blast radius. `docs.
--    backlink_dispatch` below is instead populated by the CONSUMER
--    (`taskflow_backlinks`, note 4), marking rows as PROCESSED rather than
--    a producer marking them PENDING — an anti-join on "no dispatch row
--    exists yet" that needs no producer-side write at all, apps/collab's or
--    anyone else's.
--
-- 4. taskflow_backlinks IS A FOURTH CONSUMER ROLE, mirroring taskflow_audit
--    (0007) and taskflow_realtime (0015/0016) exactly: NOBYPASSRLS, its own
--    pool, `withBacklinksScope` clearing app.org_id so ONE relay tick can
--    claim work across every tenant the same way `drainOutbox` does. What
--    makes it narrower than either precedent: it holds COLUMN-LEVEL SELECT
--    on docs.page_versions — (id, org_id, page_id, created_at) only, never
--    `state` — so the claim step cannot read a single byte of page content
--    even if fully compromised. The actual content read (materializing a
--    page to extract its internal links) happens afterward, per claimed
--    page, over the ORDINARY taskflow_app connection under ordinary
--    withOrgScope — the identical path `page-version.service.ts`'s
--    materializeCurrentState already uses, not a second privileged one.
--    docs.backlinks itself is written over that same ordinary connection;
--    taskflow_backlinks never touches it.

-- --------------------------------------------------------------------------
-- Comments — anchored ranges, resolve state, and rich-text bodies matching
-- work.card_comments' own shape (body jsonb + body_text for search/audit).
-- --------------------------------------------------------------------------
CREATE TABLE docs.comments (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  page_id      uuid        NOT NULL,

  -- See note 1 above. Both required: a comment always anchors a range, even
  -- a collapsed one (anchor_from = anchor_to) for a plain cursor-position
  -- comment.
  anchor_from  bytea       NOT NULL,
  anchor_to    bytea       NOT NULL,

  body         jsonb       NOT NULL,
  body_text    text        NOT NULL,

  -- Distinct from deleted_at: a resolved comment stays in the thread (the
  -- discussion is the record), it is only hidden from the default "open
  -- comments" view. Nullable — unresolved is the common case.
  resolved_at  timestamptz,
  resolved_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  author_id    uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  edited_at    timestamptz,
  deleted_at   timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT comments_page_fk
    FOREIGN KEY (org_id, page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE,
  CONSTRAINT comments_resolved_pair
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX comments_page_idx ON docs.comments (org_id, page_id, created_at)
  WHERE deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Suggestions — a tracked-change-style proposed edit over the same anchoring
-- as comments, with accept/reject STATE only (§5's Wave 3 scope: applying an
-- accepted suggestion to the live document is a client-side edit through the
-- ordinary Yjs sync session, exactly the same "known limitation, named
-- rather than assumed away" shape as restorePageVersion not reaching an
-- open live session in migration 0024/page-version.service.ts).
-- --------------------------------------------------------------------------
CREATE TABLE docs.suggestions (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL,
  page_id           uuid        NOT NULL,

  anchor_from       bytea       NOT NULL,
  anchor_to         bytea       NOT NULL,

  -- 'delete' proposes removing the anchored range and carries no content.
  -- 'insert'/'replace' carry the proposed rich text.
  kind              text        NOT NULL,
  proposed_content  jsonb,

  status            text        NOT NULL DEFAULT 'pending',
  decided_by        uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  decided_at        timestamptz,

  author_id         uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT suggestions_page_fk
    FOREIGN KEY (org_id, page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE,
  CONSTRAINT suggestions_kind_valid CHECK (kind IN ('insert', 'delete', 'replace')),
  CONSTRAINT suggestions_status_valid CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT suggestions_content_matches_kind
    CHECK ((kind = 'delete') = (proposed_content IS NULL)),
  CONSTRAINT suggestions_decided_pair
    CHECK ((status = 'pending') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL))
);

CREATE INDEX suggestions_page_pending_idx ON docs.suggestions (org_id, page_id, created_at)
  WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- Backlinks — "which pages link to this one" (§3.10). A plain edge list,
-- recomputed wholesale per source page on every pass rather than patched
-- incrementally: a delete-then-insert of one page's outgoing edges is a
-- bounded, cheap operation, and it is the only shape that can never drift
-- from "what the document currently contains" the way an incremental patch
-- could if a single link removal were ever missed.
-- --------------------------------------------------------------------------
CREATE TABLE docs.backlinks (
  org_id           uuid        NOT NULL,
  source_page_id   uuid        NOT NULL,
  target_page_id   uuid        NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, source_page_id, target_page_id),

  CONSTRAINT backlinks_source_fk
    FOREIGN KEY (org_id, source_page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE,
  CONSTRAINT backlinks_target_fk
    FOREIGN KEY (org_id, target_page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE,
  CONSTRAINT backlinks_not_self CHECK (source_page_id != target_page_id)
);

-- "What links here" — the one query this table exists to answer.
CREATE INDEX backlinks_target_idx ON docs.backlinks (org_id, target_page_id);

-- --------------------------------------------------------------------------
-- The backlinks relay's own dispatch bookkeeping. See note 3 above: a row
-- here means "this page_version has been folded into docs.backlinks",
-- written by the CONSUMER after processing, not by page_versions' writer
-- before it. Absence of a row is "not yet processed" — the same EXISTENCE
-- scan migration 0015 chose over a position cursor, and for the identical
-- reason: nothing here compares a timestamp against a high-water mark that
-- a late-committing transaction could land behind.
-- --------------------------------------------------------------------------
CREATE TABLE docs.backlink_dispatch (
  page_version_id  uuid        PRIMARY KEY
    REFERENCES docs.page_versions (id) ON DELETE CASCADE,
  org_id           uuid        NOT NULL,

  processed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT backlink_dispatch_org_fk
    FOREIGN KEY (org_id) REFERENCES identity.orgs (id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3).
-- --------------------------------------------------------------------------

ALTER TABLE docs.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.comments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comments_tenant_isolation ON docs.comments;
CREATE POLICY comments_tenant_isolation ON docs.comments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE docs.suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.suggestions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suggestions_tenant_isolation ON docs.suggestions;
CREATE POLICY suggestions_tenant_isolation ON docs.suggestions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE docs.backlinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.backlinks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backlinks_tenant_isolation ON docs.backlinks;
CREATE POLICY backlinks_tenant_isolation ON docs.backlinks
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- backlink_dispatch is ordinary tenant data (unlike platform.outbox_dispatch,
-- which is deliberately cross-tenant queue bookkeeping — see 0015's own note)
-- because it exists to be read back per-org by taskflow_app, never scanned
-- across every tenant by application code. Only the CLAIM step in
-- taskflow_backlinks' own relay needs cross-tenant reach, and that step
-- never touches this table at all — it queries docs.page_versions directly
-- (via the anti-join below) and writes here per claimed page from INSIDE
-- that page's own withOrgScope, exactly where docs.backlinks is written.
ALTER TABLE docs.backlink_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.backlink_dispatch FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS backlink_dispatch_tenant_isolation ON docs.backlink_dispatch;
CREATE POLICY backlink_dispatch_tenant_isolation ON docs.backlink_dispatch
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- taskflow_app already has default privileges on every table in the `docs`
-- schema (migration 0001), so comments/suggestions/backlinks/backlink_dispatch
-- need no explicit GRANT here — the same fact page-version.service.ts's own
-- header confirmed empirically for yjs_updates/page_versions in migration
-- 0024 applies identically to every table this migration adds.

-- --------------------------------------------------------------------------
-- taskflow_backlinks — see note 4 above.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA docs TO taskflow_backlinks;

-- The claim step. Column-level, and deliberately excludes `state` — the
-- role that finds out WHICH pages changed never has a code path capable of
-- reading what changed.
GRANT SELECT (id, org_id, page_id, created_at) ON docs.page_versions TO taskflow_backlinks;

DROP POLICY IF EXISTS page_versions_backlinks_claim ON docs.page_versions;
CREATE POLICY page_versions_backlinks_claim ON docs.page_versions
  FOR SELECT TO taskflow_backlinks
  USING (true);

-- The anti-join target and the processed-marker write. Cross-tenant, exactly
-- like platform.outbox_dispatch's taskflow_audit/taskflow_realtime policies
-- — this role's SELECT/INSERT here is what makes the claim query's LEFT
-- JOIN work across every org in one pass.
GRANT SELECT, INSERT ON docs.backlink_dispatch TO taskflow_backlinks;

DROP POLICY IF EXISTS backlink_dispatch_backlinks_all ON docs.backlink_dispatch;
CREATE POLICY backlink_dispatch_backlinks_all ON docs.backlink_dispatch
  FOR ALL TO taskflow_backlinks
  USING (true)
  WITH CHECK (true);
