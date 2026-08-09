-- 0035 down — reverse the platform-admin wave.
--
-- Order matters: drop the policies and grants before the tables they name,
-- the trigger before the function, the function before the log, the log
-- before its head. The bootstrap operator row goes with platform.operators.

DROP POLICY IF EXISTS memberships_platform_admin_read ON identity.memberships;
DROP POLICY IF EXISTS orgs_platform_admin_status_write ON identity.orgs;
DROP POLICY IF EXISTS orgs_platform_admin_read ON identity.orgs;

REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides FROM taskflow_platform_admin;
REVOKE SELECT ON platform.operators FROM taskflow_platform_admin;
REVOKE SELECT ON identity.users FROM taskflow_platform_admin;
REVOKE SELECT ON identity.memberships FROM taskflow_platform_admin;
REVOKE SELECT, UPDATE ON identity.orgs FROM taskflow_platform_admin;
REVOKE USAGE ON SCHEMA platform FROM taskflow_platform_admin;
REVOKE USAGE ON SCHEMA identity FROM taskflow_platform_admin;

REVOKE SELECT ON platform.operator_audit_log FROM taskflow_app;
REVOKE SELECT, UPDATE ON platform.operator_chain_head FROM taskflow_platform_admin;
REVOKE SELECT, INSERT ON platform.operator_audit_log FROM taskflow_platform_admin;

DROP TRIGGER operator_audit_log_chain ON platform.operator_audit_log;
DROP FUNCTION platform.operator_chain_entry();
DROP TABLE platform.operator_audit_log;
DROP TABLE platform.operator_chain_head;

REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides FROM taskflow_app;
REVOKE SELECT ON platform.operators FROM taskflow_app;

DROP TABLE platform.flag_overrides;
DROP TABLE platform.operators;
