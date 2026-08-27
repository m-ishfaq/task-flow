-- 0084 — operator broadcasts: a hand-picked SUBSET of members, not just one
-- (Phase 12, platform-admin console).
--
-- 0083's 'user' target could only ever name a single member. That made the
-- console's own picker needlessly literal: an operator choosing "these three
-- people" out of ten had to run the whole compose/preview/send cycle three
-- times, once per person — three tracking rows and three org-audit entries
-- for what was really one decision. 'role' already reaches an unbounded set
-- of members with one row; a hand-picked set should not be worse than that.
--
-- Widened to `audience_user_ids uuid[]`. No production data to migrate: this
-- table shipped in 0083, in the same unreleased slice as this migration, so
-- there is nothing depending on the old singular shape — a clean replace
-- rather than an expand-then-later-contract two-step. (The down migration
-- still degrades the array to its first element for the up->down->up
-- round-trip `migrate:verify` exercises against `taskflow_test`, which is
-- lossy but harmless — there is no real multi-user row anywhere to lose.)

ALTER TABLE platform.operator_broadcasts
  DROP CONSTRAINT operator_broadcasts_audience_consistent;

ALTER TABLE platform.operator_broadcasts
  DROP CONSTRAINT operator_broadcasts_audience_target_valid;

ALTER TABLE platform.operator_broadcasts
  ADD COLUMN audience_user_ids uuid[];

UPDATE platform.operator_broadcasts
  SET audience_user_ids = ARRAY[audience_user_id]
  WHERE audience_target = 'user' AND audience_user_id IS NOT NULL;

UPDATE platform.operator_broadcasts
  SET audience_target = 'users'
  WHERE audience_target = 'user';

ALTER TABLE platform.operator_broadcasts
  DROP COLUMN audience_user_id;

ALTER TABLE platform.operator_broadcasts
  ADD CONSTRAINT operator_broadcasts_audience_target_valid
    CHECK (audience_target IN ('all', 'role', 'users'));

-- Same "representable states are valid states" discipline as 0083's own
-- version of this constraint — 'users' additionally requires a NON-EMPTY
-- array, so an empty-array send (which would silently reach nobody) is
-- refused by the database, not just by the service.
ALTER TABLE platform.operator_broadcasts
  ADD CONSTRAINT operator_broadcasts_audience_consistent
    CHECK (
      (audience_target = 'all'   AND audience_role IS NULL AND audience_user_ids IS NULL) OR
      (audience_target = 'role'  AND audience_role IS NOT NULL AND audience_user_ids IS NULL) OR
      (audience_target = 'users' AND audience_role IS NULL AND audience_user_ids IS NOT NULL
        AND array_length(audience_user_ids, 1) > 0)
    );
