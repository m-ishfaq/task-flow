-- 0050 — API tokens (down). Reverses the up file in strict reverse order.

DROP POLICY IF EXISTS api_tokens_auth_lookup ON platform.api_tokens;
REVOKE USAGE ON SCHEMA platform FROM taskflow_api_token_auth;
REVOKE SELECT (token_hash, org_id, created_by, scopes, revoked_at)
  ON platform.api_tokens FROM taskflow_api_token_auth;

DROP POLICY IF EXISTS api_tokens_tenant_isolation ON platform.api_tokens;
ALTER TABLE platform.api_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.api_tokens NO FORCE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE ON platform.api_tokens FROM taskflow_app;

DROP TABLE platform.api_tokens;
