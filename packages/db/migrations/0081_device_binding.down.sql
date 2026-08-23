ALTER TABLE identity.sessions
  DROP CONSTRAINT sessions_device_key_paired;

ALTER TABLE identity.sessions
  DROP COLUMN device_public_key_x,
  DROP COLUMN device_public_key_y,
  DROP COLUMN device_key_registered_at;
