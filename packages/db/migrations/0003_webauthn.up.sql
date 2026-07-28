-- 0003 — passkeys: WebAuthn credentials and ceremony challenges (PLAN.md §8.1)
--
-- Same tenancy position as 0002 and for the same reason: a passkey belongs to a
-- PERSON, not to an organization, and signing in happens before any org is
-- known. No org_id, no RLS, reachable only through withGlobalScope, which lint
-- restricts to the identity module.
--
-- Nothing here is a secret in the way a password hash is. A WebAuthn public key
-- is public by construction, and a credential id is a random identifier the
-- authenticator hands to anyone who asks for the right origin. What must be
-- protected is INTEGRITY: an attacker who could insert a row into
-- webauthn_credentials would own every account they chose.

-- --------------------------------------------------------------------------
-- Credentials
-- --------------------------------------------------------------------------
CREATE TABLE identity.webauthn_credentials (
  id                 uuid        PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,

  -- Base64URL exactly as the browser reports it, not the decoded bytes. The
  -- value is compared against what a client sends on every assertion, and
  -- re-encoding on each comparison is a place for a padding or alphabet
  -- mismatch to make a valid credential unrecognizable.
  --
  -- UNIQUE across the whole table, not per user: a credential id identifies one
  -- authenticator key pair globally, and the same one appearing under two
  -- accounts means either a bug or an attempt to bind someone else's key.
  credential_id      text        NOT NULL UNIQUE,

  -- COSE-encoded public key. Public by construction — the security of this row
  -- is its integrity, never its confidentiality.
  public_key         bytea       NOT NULL,

  -- Signature counter. A genuine authenticator only ever counts up, so a value
  -- at or below the stored one means the credential has been cloned. Many
  -- platform authenticators report 0 forever, which is why the check applies
  -- only once a nonzero value has been seen.
  sign_count         bigint      NOT NULL DEFAULT 0,

  -- Hints for the browser's UI ('internal', 'hybrid', 'usb', ...). Advisory
  -- only; nothing is authorized on the basis of them.
  transports         text[]      NOT NULL DEFAULT '{}',

  -- Authenticator model. Recorded for support and for a future enterprise
  -- attestation policy (Phase 12); NOT verified today, because verifying it
  -- means maintaining the FIDO metadata blob and root certificates.
  aaguid             text,

  -- 'singleDevice' never leaves its authenticator; 'multiDevice' syncs through
  -- a provider. Worth storing because the recovery story differs: losing the
  -- only single-device credential loses the account.
  device_type        text        NOT NULL,
  backed_up          boolean     NOT NULL DEFAULT false,

  -- User-chosen label ("MacBook Touch ID"). Free text shown back to its owner
  -- only, and rendered as text — never as HTML.
  name               text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,

  CONSTRAINT webauthn_credentials_device_type_check
    CHECK (device_type IN ('singleDevice', 'multiDevice')),
  CONSTRAINT webauthn_credentials_name_length_check
    CHECK (name IS NULL OR char_length(name) <= 64)
);

CREATE INDEX webauthn_credentials_user_id_idx
  ON identity.webauthn_credentials (user_id);

-- --------------------------------------------------------------------------
-- Ceremony challenges
-- --------------------------------------------------------------------------
--
-- WebAuthn requires the server to remember the challenge it issued and to
-- verify that the assertion signs THAT value. Where the challenge is kept is a
-- real decision:
--
--   * In a cookie — no server state, but the client holds it, so replay is
--     bounded only by however the cookie is protected.
--   * In memory — fine on one instance, wrong on two.
--   * Here — one row, consumed by a conditional UPDATE, so a challenge is
--     usable exactly once no matter how many requests arrive together.
--
-- The single-use property is the point. A replayed assertion is a complete
-- authentication bypass, and it is the failure that a check-then-delete would
-- allow under concurrency.
CREATE TABLE identity.webauthn_challenges (
  id                 uuid        PRIMARY KEY,

  -- Base64URL, as generated. UNIQUE so a repeated value cannot create a second
  -- consumable row — with 32 random bytes a collision means the CSPRNG failed,
  -- and that must surface as a constraint violation rather than pass silently.
  challenge          text        NOT NULL UNIQUE,

  -- NULL for a sign-in ceremony. Sign-in uses discoverable credentials so the
  -- server does not learn who is authenticating until the assertion arrives —
  -- which is exactly what keeps the login page from being an account-existence
  -- oracle. Registration always names the user, because they are already
  -- signed in.
  user_id            uuid        REFERENCES identity.users(id) ON DELETE CASCADE,

  purpose            text        NOT NULL,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webauthn_challenges_purpose_check
    CHECK (purpose IN ('registration', 'authentication')),

  -- A registration challenge must name its user; an authentication one must
  -- not. Expressed here because it is the invariant that stops a sign-in
  -- ceremony from being completed as an enrollment for whoever it names.
  CONSTRAINT webauthn_challenges_user_pairing_check
    CHECK (
      (purpose = 'registration'   AND user_id IS NOT NULL) OR
      (purpose = 'authentication' AND user_id IS NULL)
    )
);

-- Supports the expiry sweep. Partial, because a consumed challenge is never
-- swept and including those rows would make the index mostly dead weight.
CREATE INDEX webauthn_challenges_expires_at_idx
  ON identity.webauthn_challenges (expires_at)
  WHERE consumed_at IS NULL;
