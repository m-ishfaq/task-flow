-- Reverses 0077. Dropping the column restores the replay window it closed —
-- see the up migration's own header before doing this on a live database.
ALTER TABLE identity.totp_credentials
  DROP COLUMN IF EXISTS last_used_step;
