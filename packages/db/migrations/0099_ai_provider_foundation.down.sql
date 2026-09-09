-- Down for 0099 — Phase 15 §2+§3: the AI provider foundation.
--
-- Children before parents: `ai.usage_ledger` and `platform.ai_org_overrides`
-- both reference `platform.ai_provider_config` (the override table directly;
-- the ledger only by convention, not a foreign key, since a config row may be
-- retired while its history stays), so both drop first.

REVOKE SELECT ON ai.usage_ledger FROM taskflow_platform_admin;
REVOKE SELECT, INSERT ON ai.usage_ledger FROM taskflow_app;
DROP POLICY IF EXISTS usage_ledger_platform_admin_read ON ai.usage_ledger;
DROP POLICY IF EXISTS usage_ledger_tenant_isolation ON ai.usage_ledger;
DROP TABLE IF EXISTS ai.usage_ledger;

REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.ai_org_overrides FROM taskflow_platform_admin;
REVOKE SELECT ON platform.ai_org_overrides FROM taskflow_app;
DROP POLICY IF EXISTS ai_org_overrides_platform_admin_all ON platform.ai_org_overrides;
DROP POLICY IF EXISTS ai_org_overrides_tenant_isolation ON platform.ai_org_overrides;
DROP TABLE IF EXISTS platform.ai_org_overrides;

REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.ai_provider_config FROM taskflow_platform_admin;
REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.ai_provider_config FROM taskflow_app;
DROP TABLE IF EXISTS platform.ai_provider_config;

REVOKE USAGE ON SCHEMA ai FROM taskflow_platform_admin;
REVOKE USAGE ON SCHEMA ai FROM taskflow_app;
DROP SCHEMA IF EXISTS ai;
