-- Revert 0006 — transactional outbox.
--
-- The grants on platform.outbox go with the table. The schema-level USAGE grant
-- to taskflow_audit is revoked explicitly, since it outlives the table.

DROP TABLE IF EXISTS platform.outbox;

REVOKE USAGE ON SCHEMA platform FROM taskflow_audit;
