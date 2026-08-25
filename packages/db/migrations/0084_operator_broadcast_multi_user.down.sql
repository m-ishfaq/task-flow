ALTER TABLE platform.operator_broadcasts
  DROP CONSTRAINT operator_broadcasts_audience_consistent;

ALTER TABLE platform.operator_broadcasts
  DROP CONSTRAINT operator_broadcasts_audience_target_valid;

ALTER TABLE platform.operator_broadcasts
  ADD COLUMN audience_user_id uuid REFERENCES identity.users (id) ON DELETE SET NULL;

-- Lossy for a row with more than one id — see the up migration's header.
UPDATE platform.operator_broadcasts
  SET audience_user_id = audience_user_ids[1]
  WHERE audience_target = 'users' AND audience_user_ids IS NOT NULL;

UPDATE platform.operator_broadcasts
  SET audience_target = 'user'
  WHERE audience_target = 'users';

ALTER TABLE platform.operator_broadcasts
  DROP COLUMN audience_user_ids;

ALTER TABLE platform.operator_broadcasts
  ADD CONSTRAINT operator_broadcasts_audience_target_valid
    CHECK (audience_target IN ('all', 'role', 'user'));

ALTER TABLE platform.operator_broadcasts
  ADD CONSTRAINT operator_broadcasts_audience_consistent
    CHECK (
      (audience_target = 'all'  AND audience_role IS NULL AND audience_user_id IS NULL) OR
      (audience_target = 'role' AND audience_role IS NOT NULL AND audience_user_id IS NULL) OR
      (audience_target = 'user' AND audience_role IS NULL AND audience_user_id IS NOT NULL)
    );
