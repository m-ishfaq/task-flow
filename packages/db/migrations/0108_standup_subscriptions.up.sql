-- 0108 — an opt-in daily email of a project's standup
-- (ai/phase-15-ai-copilot-and-permissions.md §5's own text: "an optional
-- emailed copy can reuse the existing notification-mail path later if
-- wanted" — this is that later. §5 itself deliberately shipped with no
-- emailed report at all; this adds it as an opt-in, not a default.
--
-- One row is "this member wants THIS project's standup emailed to them,
-- daily" — nothing more. Subscribing/unsubscribing goes through the
-- ordinary tenant-scoped route (a person's own choice about their own
-- inbox); the daily sweep that actually SENDS the mail needs to see every
-- org's subscriptions in one pass, which is why this gets the identical
-- second grant + permissive policy migration 0027 already gave
-- platform.notification_deliveries for the identical reason.

CREATE TABLE platform.standup_subscriptions (
  id         uuid        PRIMARY KEY,
  org_id     uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  project_id uuid        NOT NULL REFERENCES work.projects (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One subscription per (person, project) — subscribing twice is a no-op,
-- not a second row.
CREATE UNIQUE INDEX standup_subscriptions_unique
  ON platform.standup_subscriptions (org_id, project_id, user_id);

-- "Am I subscribed" and "who is subscribed to this project" both filter on
-- (org, project).
CREATE INDEX standup_subscriptions_project_idx
  ON platform.standup_subscriptions (org_id, project_id);

ALTER TABLE platform.standup_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.standup_subscriptions FORCE  ROW LEVEL SECURITY;

CREATE POLICY standup_subscriptions_tenant_isolation ON platform.standup_subscriptions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The daily digest sweep (running as taskflow_audit, which sets neither
-- app.org_id nor app.user_id — see 0022's own note on why) needs to see
-- every org's subscriptions in one pass. Read-only: taskflow_audit never
-- writes a subscription, a person does, through the tenant-scoped route
-- above. Mirrors 0027's identical grant on platform.notification_deliveries.
GRANT SELECT ON platform.standup_subscriptions TO taskflow_audit;

CREATE POLICY standup_subscriptions_audit_read ON platform.standup_subscriptions
  FOR SELECT TO taskflow_audit
  USING (true);
