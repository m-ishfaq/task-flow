-- 0114 — platform.system_settings: runtime-configurable platform settings
--
-- Operational settings that an operator can change without a deploy/restart.
-- Stored as typed key-value rows so the config tab can present them as editable
-- controls without needing per-setting columns or a migration for each one.
--
-- taskflow_app reads at startup and periodically (cached in-process) to enforce
-- maintenance mode, registration toggle, etc. taskflow_platform_admin has full
-- CRUD through the operator console.

CREATE TABLE platform.system_settings (
  key         text PRIMARY KEY,
  value       jsonb   NOT NULL,
  description text    NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS: tenant-scoped read for taskflow_app, full operator access
ALTER TABLE platform.system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_settings_app_read ON platform.system_settings
  FOR SELECT TO taskflow_app
  USING (true);

CREATE POLICY system_settings_admin_all ON platform.system_settings
  FOR ALL TO taskflow_platform_admin
  USING (true)
  WITH CHECK (true);

-- Seed defaults
INSERT INTO platform.system_settings (key, value, description) VALUES
  ('maintenance_mode',    'false',                       'Site-wide maintenance mode — returns 503 on all non-operator routes'),
  ('maintenance_message', '"We are performing scheduled maintenance. Please check back shortly."',
                                                                        'Banner message shown during maintenance'),
  ('registration_enabled','true',                         'Allow new user registrations'),
  ('step_up_max_age_min', '5',                            'Minutes before a step-up session expires'),
  ('lockout_threshold',   '5',                            'Failed auth attempts before lockout'),
  ('lockout_duration_min','15',                            'Minutes an account stays locked');
