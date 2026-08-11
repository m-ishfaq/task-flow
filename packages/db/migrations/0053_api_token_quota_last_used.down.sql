-- 0053 down — restore the duplicate column. Only the migration runner does
-- this; the application writes last_used_at on platform.api_tokens instead.
ALTER TABLE platform.api_token_quota ADD COLUMN last_used_at timestamptz;
