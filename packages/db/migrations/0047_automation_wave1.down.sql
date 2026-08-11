-- 0047 down — reverse the automation rules engine.
--
-- Policies and grants come off before the tables they name, so a partially
-- applied down leaves no policy pointing at a table that no longer exists —
-- the ordering 0041's down documents and 0045/0046 repeat.

DROP POLICY IF EXISTS outbox_dispatch_automation_update ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_automation_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_automation_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_automation_mark ON platform.outbox;
DROP POLICY IF EXISTS outbox_automation_read ON platform.outbox;

DROP POLICY IF EXISTS automation_budget_tenant_isolation ON platform.automation_budget;
DROP POLICY IF EXISTS automation_runs_tenant_isolation ON platform.automation_runs;
DROP POLICY IF EXISTS automations_tenant_isolation ON platform.automations;

REVOKE SELECT, INSERT, UPDATE ON platform.outbox_dispatch FROM taskflow_automation;
REVOKE SELECT, UPDATE ON platform.outbox FROM taskflow_automation;
REVOKE USAGE ON SCHEMA platform FROM taskflow_automation;

-- Children before parents: runs reference automations through the composite FK.
DROP TABLE IF EXISTS platform.automation_budget;
DROP TABLE IF EXISTS platform.automation_runs;
DROP TABLE IF EXISTS platform.automations;

-- No REVOKE for taskflow_app on the dropped tables: DROP TABLE takes their
-- privileges with them, and the ALTER DEFAULT PRIVILEGES that granted most of
-- it in the first place belongs to 0001 and is not this migration's to undo.
