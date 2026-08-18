-- 0078 — one Argon2 per recovery-code login, not ten.
--
-- Recovery codes are Argon2id-hashed (migration 0040), which is randomly
-- salted, so a code cannot be looked up by its hash: the verifier loaded all
-- ten of a user's stored hashes and ran Argon2 against each until one matched.
-- A wrong code — every attacker attempt — exhausted all ten. Argon2 is slow by
-- design, so a single login attempt became ten of the most expensive
-- operations in the system, an amplification reachable by sending junk codes.
--
-- `code_index` is a keyed one-way equality index over the code — the same
-- blind-index construction migration 0033 uses for a call's counterparty
-- number (@taskflow/security's `recoveryCodeIndex`). The Argon2 hash stays the
-- authoritative verifier; the index only lets the login find the ONE row that
-- could match, so Argon2 runs once, or — for a code matching nothing — not at
-- all. The key is derived from the identity data key, so a stolen index column
-- is inert: it yields only "these two rows hold the same code", never the
-- codes, which are short enough (12 chars, 32-symbol alphabet) that a plain
-- hash would be brute-forceable offline.
--
-- Nullable, deliberately. Codes issued before this migration were stored with
-- only their Argon2 hash, and Argon2 is one-way — there is no plaintext to
-- compute an index from, so those rows cannot be backfilled. They keep the
-- linear-scan path (`findUnindexedRecoveryCodes`, filtered on `code_index IS
-- NULL`), a set that only shrinks: every regeneration writes indexes, and new
-- enrollments never produce a null-index row. A NOT NULL column would have
-- meant either destroying those users' fallback codes or blocking the
-- migration on a backfill that is cryptographically impossible.
--
-- The composite index is (user_id, code_index): the lookup always knows the
-- user, and pairing them keeps a keyed 128-bit value from being probed across
-- accounts. It intentionally does NOT index the null-index legacy rows — a
-- partial index would, but they are found by user_id alone in the scan path.
--
-- No RLS: identity.totp_recovery_codes is a non-tenant table, as 0040 created
-- it, and taskflow_app's SELECT/INSERT/UPDATE/DELETE on it (the schema-wide
-- default privileges from 0002) already cover the new column.
ALTER TABLE identity.totp_recovery_codes
  ADD COLUMN code_index bytea;

CREATE INDEX totp_recovery_codes_lookup_idx
  ON identity.totp_recovery_codes (user_id, code_index);

COMMENT ON COLUMN identity.totp_recovery_codes.code_index IS
  'Keyed one-way equality index (@taskflow/security recoveryCodeIndex) letting a login find the one matching code without an Argon2 scan. NULL for codes issued before migration 0078, which keep the linear-scan fallback.';
