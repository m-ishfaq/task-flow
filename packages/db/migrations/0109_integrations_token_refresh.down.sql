ALTER TABLE platform.integrations
  DROP COLUMN refresh_token_ciphertext,
  DROP COLUMN refresh_token_wrapped,
  DROP COLUMN refresh_token_master_id,
  DROP COLUMN token_expires_at,
  DROP COLUMN refresh_token_expires_at;
