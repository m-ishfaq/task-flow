-- 0032 — platform admin: reversal

DROP POLICY IF EXISTS orgs_sweep_status_read ON identity.orgs;
DROP POLICY IF EXISTS orgs_audit_status_read ON identity.orgs;
REVOKE SELECT (id, status) ON identity.orgs FROM taskflow_notification_sweep;
REVOKE SELECT (id, status) ON identity.orgs FROM taskflow_audit;

DROP POLICY IF EXISTS memberships_platform_admin_read ON identity.memberships;
DROP POLICY IF EXISTS orgs_platform_admin_status_write ON identity.orgs;
DROP POLICY IF EXISTS orgs_platform_admin_read ON identity.orgs;

REVOKE SELECT ON identity.memberships FROM taskflow_platform_admin;
REVOKE SELECT, UPDATE ON identity.orgs FROM taskflow_platform_admin;
REVOKE USAGE ON SCHEMA platform FROM taskflow_platform_admin;
REVOKE USAGE ON SCHEMA identity FROM taskflow_platform_admin;

REVOKE SELECT, INSERT, UPDATE ON platform.operator_chain_head FROM taskflow_platform_admin;
REVOKE SELECT, INSERT ON platform.operator_audit_log FROM taskflow_platform_admin;
REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.flag_overrides FROM taskflow_platform_admin;
REVOKE SELECT ON platform.operators FROM taskflow_platform_admin;

-- taskflow_app's privileges on these four tables were narrowed with REVOKE
-- in the up migration (schema 0001's default privileges are what granted
-- them in the first place), not widened with GRANT — DROP TABLE below
-- removes what's left along with the tables themselves, so there is
-- nothing to restate here.

DROP TRIGGER IF EXISTS operator_audit_log_chain ON platform.operator_audit_log;
DROP FUNCTION IF EXISTS platform.operator_chain_entry();
DROP FUNCTION IF EXISTS platform.chain_field(text);

DROP TABLE IF EXISTS platform.operator_audit_log;
DROP TABLE IF EXISTS platform.operator_chain_head;
DROP TABLE IF EXISTS platform.flag_overrides;
DROP TABLE IF EXISTS platform.operators;
