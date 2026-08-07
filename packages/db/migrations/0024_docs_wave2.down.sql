-- Revert 0024 — docs: the Yjs write-ahead log and page versions.
--
-- Dropped children-first (both reference docs.pages, not each other, so
-- their relative order does not matter). taskflow_collab is left in place —
-- roles are cluster-wide (02-roles.sql), and a down migration that dropped a
-- role would also have to guess whether some OTHER migration, on some other
-- branch, still expects it to exist.
--
-- Everything lost by reverting this migration is CRDT working state and
-- version history, never the tree or metadata Wave 1 shipped — docs.pages
-- and docs.spaces are untouched.

REVOKE SELECT, INSERT, DELETE ON docs.yjs_updates   FROM taskflow_collab;
REVOKE SELECT, INSERT         ON docs.page_versions FROM taskflow_collab;
REVOKE USAGE ON SCHEMA docs FROM taskflow_collab;

DROP TABLE IF EXISTS docs.page_versions;
DROP TABLE IF EXISTS docs.yjs_updates;

DROP INDEX IF EXISTS docs.pages_org_id_key;
