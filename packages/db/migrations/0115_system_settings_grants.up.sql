-- 0115 — fix missing GRANTs on platform.system_settings (0114 shipped without them)
--
-- RLS policies alone are not enough: Postgres requires the role to hold
-- table-level privileges BEFORE RLS even evaluates. Without these GRANTs
-- the operator console's config tab hits "permission denied for table
-- system_settings" and the app's own startup read fails silently.

GRANT SELECT ON platform.system_settings TO taskflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.system_settings TO taskflow_platform_admin;
