-- Reverses 0079. Dropping expires_at makes every surviving token forever-valid
-- again — see the up migration before running this on a live database.
REVOKE SELECT (expires_at) ON platform.api_tokens FROM taskflow_api_token_auth;

ALTER TABLE platform.api_tokens
  DROP CONSTRAINT IF EXISTS api_tokens_expiry_after_creation;

ALTER TABLE platform.api_tokens
  DROP COLUMN IF EXISTS expires_at;
