-- 0033 — identity extras: user suspension, TOTP, OAuth, org deletion
-- (Phase 12 Wave 2, ai/phase-12-wave2.md)
--
-- Five things land in this one migration, because Wave 2's six feature slices
-- share this one schema surface (ai/phase-12-wave2.md §3):
--
--   1. identity.secret_keys — a SINGLETON wrapped data key (§3.2), the first
--      real KeyProvider consumer in this codebase. Unlike platform.operators
--      (Wave 1), there is no privilege-escalation risk in taskflow_app
--      reading or writing this row — the wrapped blob is safe ciphertext,
--      and the only real secret (the master key) lives in KeyProvider's own
--      config, never in this table. So this migration adds NO grant
--      restrictions here; the schema-wide default privileges from migration
--      0002 are exactly right, unlike migration 0032's platform.operators
--      REVOKE dance.
--   2. identity.totp_credentials / identity.totp_recovery_codes — TOTP as a
--      second factor (§3.2).
--   3. identity.oauth_identities — OAuth account linking (§3.3).
--   4. DELETE grant + policy for taskflow_platform_admin on identity.orgs
--      (§3.5) — org deletion. Verified empirically against real Postgres,
--      not assumed: a foreign-key ON DELETE CASCADE action BYPASSES ROW
--      LEVEL SECURITY on the referencing (child) table entirely — this is
--      documented Postgres behavior ("referential integrity checks...
--      always bypass row security"), confirmed with a throwaway
--      parent/child RLS fixture before writing this migration. Every
--      org_id foreign key in this schema already carries ON DELETE CASCADE
--      (checked: all 11 direct references to identity.orgs(id) across
--      every migration through 0032), so a single DELETE on identity.orgs,
--      run as taskflow_platform_admin, correctly removes every downstream
--      row across Work/Chat/Docs/People/audit/outbox with NO additional
--      grants or policies needed on any of those tables. This is the one
--      finding in this migration that is verified by a real connection
--      rather than reasoned about — see the empirical test run before this
--      file was written, and packages/db's own cascade test that pins it
--      permanently.
--   5. No change needed to identity.users' status CHECK — 'active' |
--      'suspended' | 'deleted' already covers what user suspension needs
--      (users_status_valid, migration 0002), the identical "the column was
--      already real, only enforcement was missing" shape Wave 1 found for
--      identity.orgs.status.

-- --------------------------------------------------------------------------
-- 1. identity.secret_keys (§3.2)
--
-- One row, ever. Created by application code at boot (main.ts), not by this
-- migration — a migration runs as plain SQL with no access to KeyProvider or
-- the master key material a real wrap requires. The CHECK makes a second row
-- impossible rather than merely unlikely, the identical singleton shape
-- platform.operator_chain_head (migration 0032) already uses.
-- --------------------------------------------------------------------------
CREATE TABLE identity.secret_keys (
  id            boolean     PRIMARY KEY DEFAULT true,
  wrapped_key   bytea       NOT NULL,
  master_key_id text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT secret_keys_singleton CHECK (id)
);

-- --------------------------------------------------------------------------
-- 2. TOTP (§3.2)
--
-- `secret_encrypted` is ciphertext under identity.secret_keys' data key —
-- never plaintext, never logged. `confirmed_at IS NULL` means "enrolled but
-- never proven with a real code from the app" — unusable for login or
-- step-up until confirmed, which is what stops an interrupted enrollment
-- from silently locking someone out of an account they never finished
-- securing.
-- --------------------------------------------------------------------------
CREATE TABLE identity.totp_credentials (
  user_id           uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  secret_encrypted  bytea       NOT NULL,
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Recovery codes are Argon2id-hashed, the same primitive as
-- identity.users.password_hash — one-time use, `used_at` set on redemption
-- and never unset. Ten are issued at confirmation and never re-shown, the
-- same "shown once, gone forever" discipline a passkey's own secret already
-- gets.
CREATE TABLE identity.totp_recovery_codes (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  code_hash   text        NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX totp_recovery_codes_user_idx ON identity.totp_recovery_codes (user_id);

-- --------------------------------------------------------------------------
-- 3. OAuth account linking (§3.3)
--
-- `provider_user_id` is the PROVIDER'S OWN stable subject id, never the
-- email — an email can change at the provider; a subject id does not, and
-- keying on email would let an attacker who later acquires a former
-- employee's email address at the provider inherit their linked account
-- here. `email` is captured for display only, at link time, and never
-- re-derives identity.users.email, which stays the account's own.
-- --------------------------------------------------------------------------
CREATE TABLE identity.oauth_identities (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  provider          text        NOT NULL,
  provider_user_id  text        NOT NULL,
  email             text        NOT NULL,
  linked_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT oauth_identities_provider_valid CHECK (provider IN ('google', 'github')),
  -- One provider identity links to exactly one account.
  CONSTRAINT oauth_identities_provider_key UNIQUE (provider, provider_user_id),
  -- One account links at most once per provider.
  CONSTRAINT oauth_identities_user_provider_key UNIQUE (user_id, provider)
);

-- --------------------------------------------------------------------------
-- 4. Org deletion — taskflow_platform_admin needs DELETE on identity.orgs
-- (§3.5)
--
-- Migration 0032 granted this role SELECT and UPDATE only (§3.7 — status
-- suspend/reactivate). Deletion is a distinct, far more consequential
-- capability, so it is its own grant and its own policy rather than widened
-- into the existing UPDATE one.
-- --------------------------------------------------------------------------
CREATE POLICY orgs_platform_admin_delete ON identity.orgs
  FOR DELETE TO taskflow_platform_admin USING (true);

GRANT DELETE ON identity.orgs TO taskflow_platform_admin;
