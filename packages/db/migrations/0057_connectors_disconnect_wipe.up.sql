-- 0057 — a disconnected connector is a wiped connector (Wave 4 slice 2 review)
--
-- 0056 declared token_ciphertext / token_wrapped / token_master_id NOT NULL,
-- because a connector row without a credential was never supposed to exist.
-- Slice 2's disconnect then ran into the wall the NOT NULL was built for: the
-- reviewer pass on the connect/disconnect flow found that "disconnect" only
-- flipped status, leaving the token in place and decryptable — so a stale
-- picker or an admin with the id could resurrect a deliberately-revoked
-- connector with the old token, contradicting the service's own "its
-- credential stays dead" guarantee.
--
-- The fix is semantic, not cosmetic: a 'disconnected' row means one of two
-- things, and the PRESENCE OF THE CREDENTIAL is the discriminator.
--
--   status = 'disconnected' + credential present  →  pending repo choice
--                                                    (GitHub connect in flight)
--   status = 'disconnected' + credential NULL      →  revoked
--
-- Making the three token columns nullable lets disconnectIntegration NULL them
-- (the verify_* columns were already nullable — GitHub-only). Nothing else
-- changes: rows are only ever written WITH a credential, so the NOT NULL was
-- never protecting a real invariant; it was protecting a state the service
-- was about to need to express.
--
-- No RLS change, no grant change: this is a column-constraint edit on a table
-- whose app-role grants (INSERT/UPDATE/SELECT, RLS-scoped, REVOKE DELETE)
-- already cover everything the service does with these columns.
--
-- The down migration re-adds NOT NULL, which requires the wiped rows to go:
-- they are dead by definition (no credential, revoked), so DELETE is the
-- honest rollback rather than inventing a placeholder credential.

ALTER TABLE platform.integrations
  ALTER COLUMN token_ciphertext DROP NOT NULL,
  ALTER COLUMN token_wrapped DROP NOT NULL,
  ALTER COLUMN token_master_id DROP NOT NULL;
