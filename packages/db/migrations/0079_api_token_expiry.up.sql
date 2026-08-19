-- 0079 — optional expiry for API tokens.
--
-- A `tf_pat` had no lifetime: once minted it authenticated until someone
-- revoked it by hand. A leaked token therefore stayed valid indefinitely, and
-- the only bound was a human noticing. Expiry lets the minting user cap that
-- at creation — "this CI token is good for 90 days" — while still allowing an
-- explicit forever token where that is genuinely wanted.
--
-- NULL = never expires, deliberately. Making expiry mandatory would break
-- every legitimate long-lived integration and force a default nobody chose;
-- the honest model is "pick a lifetime, or opt out on purpose". Existing rows
-- are NULL, which is exactly the pre-migration behaviour — no token silently
-- changes meaning when this runs.
--
-- Enforcement is at the auth LOOKUP (packages/db/src/api-tokens.ts), in the
-- same WHERE that already refuses a revoked token: `expires_at IS NULL OR
-- expires_at > now()`. An expired token is indistinguishable from an unknown
-- or revoked one — all three resolve to nothing — so the column is never a
-- token-existence oracle. now() is the DATABASE clock, so a token's lifetime
-- cannot be extended by lying about the time on a client.
--
-- The CHECK keeps a token from being minted already-expired: expiry, when set,
-- must be after the row was created. The service computes it as now + N days
-- server-side, so this only ever fires on a bug, but a row that claims to have
-- expired before it existed is nonsense the table should refuse.
ALTER TABLE platform.api_tokens
  ADD COLUMN expires_at timestamptz;

ALTER TABLE platform.api_tokens
  ADD CONSTRAINT api_tokens_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at);

COMMENT ON COLUMN platform.api_tokens.expires_at IS
  'When the token stops authenticating. NULL = never expires. Enforced at the auth lookup (expires_at IS NULL OR expires_at > now()), the same place revocation is.';

-- The auth lookup role must SELECT expires_at to filter on it — column-level
-- grants do NOT extend to a new column automatically, unlike the table-level
-- grant taskflow_app already holds. It gains no other new column, and still no
-- write of any kind: the same narrow shape as the rest of its grant.
GRANT SELECT (expires_at) ON platform.api_tokens TO taskflow_api_token_auth;
