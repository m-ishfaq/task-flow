-- 0002 — identity: users, sessions, refresh tokens, one-time links (PLAN.md §8.1)
--
-- These tables are deliberately NOT tenant-scoped and carry no RLS policy.
--
-- That is not an oversight, and it is the one place in the system where the
-- reasoning has to be spelled out. A user is not owned by an organization — the
-- same person can be a member of several — and every operation here happens
-- BEFORE any org is known: looking an account up by email at login, resolving a
-- verification link, exchanging a refresh token. An org_id column would have to
-- be either nullable (making the RLS predicate meaningless) or invented at
-- signup (making a second membership impossible).
--
-- So the protection is different in kind: these tables are reachable only
-- through withGlobalScope, which is restricted by lint to the identity module,
-- and nothing here is readable without a token hash or an email address that
-- the caller already possesses. Membership — the tenant-scoped part — arrives in
-- 0003 and does carry RLS.

-- --------------------------------------------------------------------------
-- Users
-- --------------------------------------------------------------------------
CREATE TABLE identity.users (
  id                 uuid        PRIMARY KEY,

  -- Two columns for one address. `email` preserves what the user typed, because
  -- that is what should appear in the UI and in outbound mail. `email_normalized`
  -- is what UNIQUE and every lookup use, so `Alice@Example.com` cannot register
  -- a second account alongside `alice@example.com`.
  --
  -- Normalization is lowercase only. Stripping dots or +suffixes is a
  -- Gmail-specific convention; applying it universally silently merges distinct
  -- addresses at other providers, and merging two people's accounts is a much
  -- worse failure than allowing an alias.
  email              text        NOT NULL,
  email_normalized   text        NOT NULL,

  email_verified_at  timestamptz,

  -- Nullable: a passkey-only account never has one (§8.1 makes WebAuthn the
  -- primary factor). Code that assumes a password exists must handle null
  -- rather than treating it as "no password required".
  password_hash      text,
  password_updated_at timestamptz,

  status             text        NOT NULL DEFAULT 'active',

  -- Throttling state. Kept on the row rather than in memory so a restart or a
  -- second API instance cannot reset an attacker's budget.
  failed_login_count integer     NOT NULL DEFAULT 0,
  locked_until       timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_status_valid CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT users_email_normalized_lower CHECK (email_normalized = lower(email_normalized))
);

CREATE UNIQUE INDEX users_email_normalized_key ON identity.users (email_normalized);

-- --------------------------------------------------------------------------
-- Sessions
--
-- One row per sign-in. The session id doubles as the refresh token FAMILY id:
-- every token issued by rotating within this session belongs to it, so revoking
-- the session revokes the whole chain in one statement (§8.1).
-- --------------------------------------------------------------------------
CREATE TABLE identity.sessions (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- When a credential was last actually PROVEN, not when the session was last
  -- used. Step-up re-authentication compares against this, so refreshing an
  -- access token must never advance it — otherwise a stolen refresh token would
  -- keep a session permanently "recently authenticated" and step-up would
  -- protect nothing.
  authenticated_at  timestamptz NOT NULL,

  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,

  revoked_at        timestamptz,
  revoked_reason    text,

  -- Recorded for the device inventory UI (Phase 12) and for incident response.
  user_agent        text,
  ip                inet,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_revocation_paired
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE INDEX sessions_user_active_idx
  ON identity.sessions (user_id)
  WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- Refresh tokens
--
-- One row per token, not one per session — that is what makes reuse detection
-- possible. Rotating stamps `rotated_at` on the old row and inserts a new one in
-- the same session. Presenting a token whose row is already rotated means the
-- token was captured and replayed, and the correct response is to revoke the
-- entire session rather than just refuse: the attacker and the legitimate user
-- now both hold tokens from the same chain, and there is no way to tell which
-- is which.
--
-- Only the hash is stored. A database dump therefore yields nothing usable.
-- --------------------------------------------------------------------------
CREATE TABLE identity.refresh_tokens (
  id           uuid        PRIMARY KEY,
  session_id   uuid        NOT NULL REFERENCES identity.sessions (id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  token_hash   text        NOT NULL,

  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The lookup path for every refresh: by hash, never by id.
CREATE UNIQUE INDEX refresh_tokens_hash_key ON identity.refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON identity.refresh_tokens (session_id);

-- --------------------------------------------------------------------------
-- One-time links: email verification and password reset
--
-- Separate tables rather than one with a `purpose` column. A single table would
-- make it possible — through a query bug rather than an attack — to consume a
-- verification token as a password reset, and that mistake reads as correct
-- code. Two tables make it a schema error.
-- --------------------------------------------------------------------------
CREATE TABLE identity.email_verifications (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- The address being proven, captured at issue time. If the user changes their
  -- email before clicking, the old link must not verify the new address.
  email        text        NOT NULL,

  token_hash   text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_verifications_hash_key ON identity.email_verifications (token_hash);
CREATE INDEX email_verifications_user_idx ON identity.email_verifications (user_id);

CREATE TABLE identity.password_resets (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  token_hash   text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,

  -- Kept for abuse analysis: a burst of requests for many accounts from one
  -- address is the signal that matters, and it is invisible without this.
  requested_ip inet,

  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_resets_hash_key ON identity.password_resets (token_hash);
CREATE INDEX password_resets_user_idx ON identity.password_resets (user_id);
