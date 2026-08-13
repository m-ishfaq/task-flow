-- Down of 0057 — restore the NOT NULL invariants. Wiped rows (a disconnect
-- nulled their credential) cannot satisfy NOT NULL and are dead by definition,
-- so they are removed rather than given a placeholder credential.

DELETE FROM platform.integrations
  WHERE token_ciphertext IS NULL;

ALTER TABLE platform.integrations
  ALTER COLUMN token_ciphertext SET NOT NULL,
  ALTER COLUMN token_wrapped SET NOT NULL,
  ALTER COLUMN token_master_id SET NOT NULL;
