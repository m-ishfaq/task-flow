-- 0073 down — reverse platform-wide branding.

REVOKE SELECT, UPDATE ON platform.branding FROM taskflow_platform_admin;
REVOKE SELECT ON platform.branding FROM taskflow_app;

DROP TABLE platform.branding;
