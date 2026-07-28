-- Revert 0007 — audit log.
--
-- Dropping the partitioned parent drops every partition with it. The trigger
-- goes with the table; the function is separate and has to be named.

DROP TABLE IF EXISTS audit.audit_log;
DROP FUNCTION IF EXISTS audit.chain_entry();
DROP FUNCTION IF EXISTS audit.chain_field(text);
DROP TABLE IF EXISTS audit.chain_heads;
