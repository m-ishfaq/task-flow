DROP POLICY IF EXISTS rollup_burndown_tenant_isolation ON analytics.rollup_burndown;
REVOKE DELETE ON analytics.rollup_burndown FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON analytics.rollup_burndown FROM taskflow_app;
DROP TABLE IF EXISTS analytics.rollup_burndown;
