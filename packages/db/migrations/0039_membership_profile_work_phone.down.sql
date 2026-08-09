-- Reverses 0039.
--
-- The CHECK goes first: dropping the column would take it along, but naming it
-- explicitly keeps the down readable as the exact inverse of the up, which is
-- what `migrate:verify` (up -> down -> up) is comparing.

ALTER TABLE people.membership_profiles
  DROP CONSTRAINT IF EXISTS membership_profiles_work_phone_e164;

ALTER TABLE people.membership_profiles
  DROP COLUMN IF EXISTS work_phone;
