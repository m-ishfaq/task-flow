-- Revert 0019 — the user display name.
--
-- Drops the column and both its constraints with it. What is lost is every name
-- anyone entered, which cannot be recovered by re-running the up file: the
-- fallback in the read path will quietly go back to rendering email addresses,
-- and nothing will look broken. The same caveat 0014 and 0017 record for their
-- own user data, restated because `migrate:verify` runs up -> down -> up
-- routinely and that can leave the impression the round trip is lossless.

ALTER TABLE identity.users DROP COLUMN IF EXISTS display_name;
