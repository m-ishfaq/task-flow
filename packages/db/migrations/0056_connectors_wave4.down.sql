-- 0056 — connectors (down). Reverses the up file in strict reverse order.

DROP POLICY IF EXISTS integrations_auth_lookup ON platform.integrations;
REVOKE USAGE ON SCHEMA platform FROM taskflow_integration_auth;
REVOKE SELECT (org_id, provider, provider_scope, verify_ciphertext, verify_wrapped, verify_master_id)
  ON platform.integrations FROM taskflow_integration_auth;

DROP POLICY IF EXISTS integrations_tenant_isolation ON platform.integrations;
ALTER TABLE platform.integrations DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.integrations NO FORCE ROW LEVEL SECURITY;

REVOKE SELECT, INSERT, UPDATE ON platform.integrations FROM taskflow_app;

DROP TABLE platform.integrations;
