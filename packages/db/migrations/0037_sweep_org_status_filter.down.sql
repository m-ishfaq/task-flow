-- 0037 down — revoke exactly what the up granted (see its header). The
-- USAGE grants on schema identity belong to 0027/0029 and are untouched here.

DROP POLICY IF EXISTS orgs_audit_status_read ON identity.orgs;
DROP POLICY IF EXISTS orgs_sweep_status_read ON identity.orgs;

REVOKE SELECT (id, status) ON identity.orgs FROM taskflow_audit;
REVOKE SELECT (id, status) ON identity.orgs FROM taskflow_notification_sweep;
