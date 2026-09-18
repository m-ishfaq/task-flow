-- 0113 — reverse: revoke platform admin access to user-detail tables

DROP POLICY IF EXISTS api_tokens_platform_admin_read ON platform.api_tokens;
REVOKE SELECT ON platform.api_tokens            FROM taskflow_platform_admin;

REVOKE SELECT ON identity.webauthn_credentials  FROM taskflow_platform_admin;
REVOKE SELECT ON identity.oauth_identities      FROM taskflow_platform_admin;
REVOKE SELECT ON identity.totp_credentials      FROM taskflow_platform_admin;
REVOKE SELECT ON identity.sessions              FROM taskflow_platform_admin;
