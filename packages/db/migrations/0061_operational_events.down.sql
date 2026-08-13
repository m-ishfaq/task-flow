-- 0061 down — drop the operations dashboard's table and grants. The role
-- itself is dropped in docker/postgres/init, never here — the same split
-- 0056's down migration follows.

REVOKE SELECT ON platform.operational_events FROM taskflow_platform_admin;

REVOKE SELECT, INSERT ON platform.operational_events FROM taskflow_ops_events;
REVOKE USAGE ON SCHEMA platform FROM taskflow_ops_events;

DROP TABLE IF EXISTS platform.operational_events;
