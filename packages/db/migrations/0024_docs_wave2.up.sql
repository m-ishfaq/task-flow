-- 0024 — docs: the Yjs write-ahead log, page versions, and taskflow_collab
-- (PLAN.md §7.2, §9; ai/phase-6-docs.md §3.7, §6.1, Wave 2)
--
-- Wave 2 of Phase 6. Three things here are load-bearing.
--
-- 1. THIS IS THE MIGRATION taskflow_collab HAS BEEN WAITING FOR.
--    §6.1 (corrected on Wave 1's approval): the role arrives the moment
--    apps/collab first needs to WRITE, and that moment is this table pair. It
--    gets INSERT/SELECT on both tables and DELETE on yjs_updates (compaction's
--    pruning) — nothing else. Not docs.pages, not docs.spaces: apps/collab's
--    onAuthenticate hook keeps reading those over the ordinary taskflow_app
--    connection, exactly as Wave 1 built it. A compromised apps/collab process
--    under this role reaches the CRDT log it owns and nothing else.
--
-- 2. yjs_updates.data IS AN OPAQUE PROTOCOL MESSAGE, NOT A BARE Y.DOC UPDATE.
--    apps/collab persists the raw y-protocols/sync sub-message bytes
--    (syncStep2 or update — never syncStep1, which carries no delta) rather
--    than hand-decoding them first. Replay feeds the same bytes back through
--    y-protocols/sync's own readSyncStep2/readUpdate, so the encode and decode
--    side share one implementation instead of two that could drift. See
--    apps/collab/src/persist.ts for why this table exists and what writes to
--    it — the WAL is written durably inside `beforeHandleMessage`, the one
--    Hocuspocus hook actually awaited before the client's sync-status ack is
--    sent (confirmed against @hocuspocus/server@4.5.0's own processMessages;
--    `onChange` looked like the natural hook and is NOT awaited there).
--
-- 3. page_versions.kind HAS NO 'publish' VALUE YET.
--    Wave 4 adds it in its own migration (expand-migrate-contract) once
--    publish-to-public actually exists. Adding it now would be a CHECK
--    constraint nothing enforces or tests until then.
--
-- No changes to docs.pages or docs.spaces — Wave 1's tree and metadata are
-- untouched. Both new tables reference pages via `pages_org_id_key`, a new
-- unique index this migration adds because neither existing unique index on
-- docs.pages includes a bare (org_id, id) — `pages_org_space_id_key` also
-- requires space_id, which these two tables have no reason to carry.

CREATE UNIQUE INDEX pages_org_id_key ON docs.pages (org_id, id);

-- --------------------------------------------------------------------------
-- The write-ahead log. See note 2 above for what `data` actually holds.
-- --------------------------------------------------------------------------
CREATE TABLE docs.yjs_updates (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  page_id     uuid        NOT NULL,

  data        bytea       NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT yjs_updates_page_fk
    FOREIGN KEY (org_id, page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE
);

-- Replay order for a page, and the query compaction issues to find rows it
-- may safely prune. `id` breaks ties — the ids are app-generated UUIDv7
-- (packages/security), so it is already close to creation order and the tie
-- break is exact rather than approximate, same reasoning as every `(rank,
-- id)` ordering elsewhere in this codebase.
CREATE INDEX yjs_updates_page_order_idx
  ON docs.yjs_updates (org_id, page_id, created_at, id);

-- --------------------------------------------------------------------------
-- Explicit, human-meaningful save points, and the periodic compacted state
-- that doubles as an autosave — see apps/collab/src/compaction.ts on why
-- there is one periodic mechanism rather than two.
-- --------------------------------------------------------------------------
CREATE TABLE docs.page_versions (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  page_id     uuid        NOT NULL,

  -- 'autosave' — written by the periodic compaction pass (§3.7's compaction
  --              worker), which is also the mechanism that prunes yjs_updates
  --              behind whichever snapshot is newest.
  -- 'manual'   — on-demand "save a version", requested through the ordinary
  --              apps/api route.
  -- No 'publish' — see note 3 above.
  kind        text        NOT NULL,

  -- A full materialized Yjs document state (Y.encodeStateAsUpdate), not a
  -- delta — "restore to this version" is a single row read applied to a
  -- fresh document, never a replay computed at restore time (§3.7's own
  -- words on why this table exists at all, distinct from the WAL).
  state       bytea       NOT NULL,

  -- Null for 'autosave' — the compaction pass is not an act any user
  -- performed, and recording one would claim an event that did not happen,
  -- the same reasoning identity.orgs' invited_by column gives for a founding
  -- owner.
  created_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT page_versions_kind_valid CHECK (kind IN ('autosave', 'manual')),

  CONSTRAINT page_versions_page_fk
    FOREIGN KEY (org_id, page_id) REFERENCES docs.pages (org_id, id) ON DELETE CASCADE
);

-- "Every version of this page, newest first" — the only query this table
-- serves, both for the version-history list and for finding the latest
-- snapshot to replay from.
CREATE INDEX page_versions_page_idx
  ON docs.page_versions (org_id, page_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE docs.yjs_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.yjs_updates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS yjs_updates_tenant_isolation ON docs.yjs_updates;
CREATE POLICY yjs_updates_tenant_isolation ON docs.yjs_updates
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE docs.page_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.page_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_versions_tenant_isolation ON docs.page_versions;
CREATE POLICY page_versions_tenant_isolation ON docs.page_versions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- taskflow_collab — see note 1 above. Same tenant-isolation policy shape as
-- taskflow_app gets implicitly through the policies above (both roles set
-- app.org_id the same way via withOrgScope-equivalent connections), so no
-- SEPARATE policy is needed the way 0016's per-consumer outbox_dispatch
-- policies were — those existed because outbox_dispatch is NOT itself
-- tenant-scoped data (it is queue bookkeeping shared across every tenant);
-- these two tables ARE ordinary tenant data, and the tenant_isolation
-- policies above already apply to every role, taskflow_collab included.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA docs TO taskflow_collab;

GRANT SELECT, INSERT, DELETE ON docs.yjs_updates    TO taskflow_collab;
GRANT SELECT, INSERT         ON docs.page_versions  TO taskflow_collab;
