-- Down migration for 0040_identity_extras.

REVOKE DELETE ON identity.orgs FROM taskflow_platform_admin;
DROP POLICY IF EXISTS orgs_platform_admin_delete ON identity.orgs;

DROP TABLE IF EXISTS identity.oauth_identities;
DROP TABLE IF EXISTS identity.totp_recovery_codes;
DROP TABLE IF EXISTS identity.totp_credentials;
DROP TABLE IF EXISTS identity.secret_keys;
