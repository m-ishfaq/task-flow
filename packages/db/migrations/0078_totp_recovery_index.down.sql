-- Reverses 0078. Dropping code_index restores the ten-Argon2-per-attempt scan
-- for every code, not just the legacy ones — see the up migration's header.
DROP INDEX IF EXISTS identity.totp_recovery_codes_lookup_idx;

ALTER TABLE identity.totp_recovery_codes
  DROP COLUMN IF EXISTS code_index;
