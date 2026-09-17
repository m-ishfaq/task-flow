-- 0113 — grant platform admin SELECT on identity security tables + api_tokens
--
-- `getUserDetail` in `org-detail.service.ts` queries these tables through
-- `withPlatformAdminScope` (the `taskflow_platform_admin` role) to power the
-- user detail inspector panel:
--
--   identity.sessions              (device inventory, impossible-travel)
--   identity.totp_credentials      (2FA status)
--   identity.oauth_identities      (linked providers)
--   identity.webauthn_credentials  (passkey inventory)
--   platform.api_tokens            (active API tokens)
--
-- The first four have no RLS and no prior grants for this role.
-- `platform.api_tokens` has tenant-isolation RLS, so we add a permissive
-- policy (the same shape migration 0035 used for `identity.orgs`) that lets
-- the platform admin role read across every org.
--
-- Read-only — the platform admin never writes to these tables.

-- identity schema tables (no RLS — GRANT is sufficient)
GRANT SELECT ON identity.sessions              TO taskflow_platform_admin;
GRANT SELECT ON identity.totp_credentials      TO taskflow_platform_admin;
GRANT SELECT ON identity.oauth_identities      TO taskflow_platform_admin;
GRANT SELECT ON identity.webauthn_credentials  TO taskflow_platform_admin;

-- platform.api_tokens — GRANT + permissive policy (has tenant-isolation RLS)
GRANT SELECT ON platform.api_tokens TO taskflow_platform_admin;

CREATE POLICY api_tokens_platform_admin_read ON platform.api_tokens
  FOR SELECT TO taskflow_platform_admin
  USING (true);
