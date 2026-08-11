-- 0051 down — remove the two columns added to the lookup role's grant.
REVOKE SELECT (id, created_at) ON platform.api_tokens FROM taskflow_api_token_auth;
