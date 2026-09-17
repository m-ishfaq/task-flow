-- 0112 — platform: grant SELECT to taskflow_platform_admin
--
-- `error-health.ts` queries `platform.automation_runs`,
-- `platform.notification_deliveries`, and `platform.webhook_deliveries`
-- through `withPlatformAdminScope` (which uses the `taskflow_platform_admin`
-- role). These tables were created by earlier migrations that only granted
-- to `taskflow_app`, so the operator console's Error Health tab fails with
-- `permission denied for table automation_runs`.
--
-- The three tables are owned by `taskflow_migrator`, so this migration
-- must run as that role to have GRANT authority. Read-only —
-- `taskflow_platform_admin` never writes to these tables.

GRANT SELECT ON platform.automation_runs       TO taskflow_platform_admin;
GRANT SELECT ON platform.notification_deliveries TO taskflow_platform_admin;
GRANT SELECT ON platform.webhook_deliveries    TO taskflow_platform_admin;
