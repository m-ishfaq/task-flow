-- 0112 — reverse: revoke SELECT from taskflow_platform_admin

REVOKE SELECT ON platform.automation_runs       FROM taskflow_platform_admin;
REVOKE SELECT ON platform.notification_deliveries FROM taskflow_platform_admin;
REVOKE SELECT ON platform.webhook_deliveries    FROM taskflow_platform_admin;
