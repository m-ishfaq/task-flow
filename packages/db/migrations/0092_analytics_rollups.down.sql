-- 0092 down — reverse analytics rollups.
--
-- Policies and grants before tables, per 0091's ordering discipline.

DROP POLICY IF EXISTS rollup_volume_tenant_isolation ON analytics.rollup_volume;
DROP POLICY IF EXISTS rollup_cycle_time_tenant_isolation ON analytics.rollup_cycle_time;
DROP POLICY IF EXISTS rollup_cfd_tenant_isolation ON analytics.rollup_cfd;
DROP POLICY IF EXISTS rollup_velocity_tenant_isolation ON analytics.rollup_velocity;

REVOKE DELETE ON analytics.rollup_volume FROM taskflow_app;
REVOKE DELETE ON analytics.rollup_cycle_time FROM taskflow_app;
REVOKE DELETE ON analytics.rollup_cfd FROM taskflow_app;
REVOKE DELETE ON analytics.rollup_velocity FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON analytics.rollup_volume FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON analytics.rollup_cycle_time FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON analytics.rollup_cfd FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON analytics.rollup_velocity FROM taskflow_app;

DROP TABLE IF EXISTS analytics.rollup_volume;
DROP TABLE IF EXISTS analytics.rollup_cycle_time;
DROP TABLE IF EXISTS analytics.rollup_cfd;
DROP TABLE IF EXISTS analytics.rollup_velocity;
