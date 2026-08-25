-- 0083 — operator broadcasts (Phase 12, platform-admin console)
--
-- A platform operator sending a message to a specific member of an org, or to
-- a role-filtered subset of an org's members. Every send is scoped to ONE org
-- — there is no platform-wide "every org" audience, deliberately: a mistake
-- here should have the blast radius of one tenant, never all of them.
--
-- `platform.operator_broadcasts` is the tracking/audit row for one send —
-- who, what audience, what content, how many people it actually reached.
-- Unlike `platform.operator_audit_log`/`platform.flag_overrides` (0035),
-- this one DOES carry a real `org_id` (every send targets exactly one org),
-- so it gets real RLS rather than the no-RLS treatment those two tables use
-- — `scripts/check-migration-rls.mjs`'s own rule is precisely "a table with
-- org_id needs ENABLE+FORCE ROW LEVEL SECURITY", and this table has no
-- pre-tenant chicken-and-egg argument (comms.subaccount_orgs's own
-- justification for its RLS_EXEMPT entry) to claim an exemption from it.
-- Read/write is operator-only for now — no product surface lets an org's
-- own admins see their own broadcast history yet — so the only policy is
-- `TO taskflow_platform_admin`, the same direct-write shape this migration
-- gives `platform.notifications` below.
--
-- Delivery reuses `platform.notifications`/`platform.notification_deliveries`
-- (0022, 0027) rather than inventing a second delivery path — the existing
-- push/email drains do not care who created a row, only that it exists. But
-- `taskflow_platform_admin` holds no outbox grant (0035's own header, and
-- org-directory.service.ts's suspend/reactivate mail already document why:
-- this role writes user-facing effects DIRECTLY, never through the
-- projection), so this migration gives it the same direct-write treatment
-- 0022 already gave `taskflow_audit` for the identical reason — mirrored
-- exactly, just for a different role.

CREATE TABLE platform.operator_broadcasts (
  id                uuid        PRIMARY KEY,
  operator_id       uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  org_id            uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- 'all'  — every active member of the org.
  -- 'role' — active members holding `audience_role`.
  -- 'user' — exactly `audience_user_id`, who must be an active member.
  audience_target   text        NOT NULL,
  audience_role     text,
  audience_user_id  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  subject           text        NOT NULL,
  body              text        NOT NULL,

  -- Per-send channel choice (§ design decision: not every message should
  -- become an email). In-app is not listed — it is not optional, the same
  -- way it is not optional for any other notification kind.
  send_push         boolean     NOT NULL DEFAULT true,
  send_email        boolean     NOT NULL DEFAULT false,

  -- Whether this send also wrote an entry into the TARGET ORG's own
  -- audit.audit_log (visible to that org's own admins), or stayed purely on
  -- the global operator chain. Recorded here so the dry-run/history view can
  -- show which past sends are visible to the org and which are not.
  included_in_org_audit boolean NOT NULL DEFAULT true,

  -- How many notification rows this send actually produced — the dry-run
  -- count, persisted rather than re-derived, so a later membership change
  -- cannot rewrite the historical record of how many people were reached.
  recipient_count   integer     NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT operator_broadcasts_audience_target_valid
    CHECK (audience_target IN ('all', 'role', 'user')),

  CONSTRAINT operator_broadcasts_role_valid
    CHECK (audience_role IS NULL OR audience_role IN ('owner', 'admin', 'member', 'guest')),

  -- Audience fields present iff the target kind that needs them was chosen —
  -- the same "representable states are valid states" discipline
  -- attachments_scan_recorded (0010) already uses for its own status/scanned_at pair.
  CONSTRAINT operator_broadcasts_audience_consistent
    CHECK (
      (audience_target = 'all'  AND audience_role IS NULL AND audience_user_id IS NULL) OR
      (audience_target = 'role' AND audience_role IS NOT NULL AND audience_user_id IS NULL) OR
      (audience_target = 'user' AND audience_role IS NULL AND audience_user_id IS NOT NULL)
    ),

  -- Plain text, short — an announcement, not a chat message. No rich text:
  -- this is rendered into a push payload and an email subject line, neither
  -- of which is a TipTap surface.
  CONSTRAINT operator_broadcasts_subject_present CHECK (length(btrim(subject)) > 0),
  CONSTRAINT operator_broadcasts_subject_length  CHECK (length(subject) <= 120),
  CONSTRAINT operator_broadcasts_body_present    CHECK (length(btrim(body)) > 0),
  CONSTRAINT operator_broadcasts_body_length     CHECK (length(body) <= 2000),

  CONSTRAINT operator_broadcasts_recipient_count_valid CHECK (recipient_count >= 0)
);

CREATE INDEX operator_broadcasts_org_idx
  ON platform.operator_broadcasts (org_id, created_at DESC);

ALTER TABLE platform.operator_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.operator_broadcasts FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON platform.operator_broadcasts TO taskflow_platform_admin;

DROP POLICY IF EXISTS operator_broadcasts_platform_admin ON platform.operator_broadcasts;
CREATE POLICY operator_broadcasts_platform_admin ON platform.operator_broadcasts
  TO taskflow_platform_admin
  USING (true)
  WITH CHECK (true);

-- --------------------------------------------------------------------------
-- Extend platform.notifications / platform.notification_deliveries so an
-- operator broadcast is a first-class kind, delivered by the EXISTING drains.
-- --------------------------------------------------------------------------

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed',
      'webhook.disabled',
      'member.added', 'member.role_changed', 'member.removed',
      'operator_broadcast'
    ));

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call', 'webhook', 'membership', 'operator_broadcast'));

-- The direct-write grant, mirrored from 0022's `notifications_projection_write`
-- (there: `taskflow_audit`, writing on behalf of the outbox projection; here:
-- `taskflow_platform_admin`, writing on behalf of an operator action). Both
-- exist for the identical reason: the writing role sets no `app.org_id`, so
-- the ordinary tenant-isolation policy matches nothing for it.
GRANT SELECT, INSERT ON platform.notifications TO taskflow_platform_admin;

DROP POLICY IF EXISTS notifications_platform_admin_write ON platform.notifications;
CREATE POLICY notifications_platform_admin_write ON platform.notifications
  FOR INSERT TO taskflow_platform_admin
  WITH CHECK (true);

DROP POLICY IF EXISTS notifications_platform_admin_read ON platform.notifications;
CREATE POLICY notifications_platform_admin_read ON platform.notifications
  FOR SELECT TO taskflow_platform_admin
  USING (true);

GRANT SELECT, INSERT ON platform.notification_deliveries TO taskflow_platform_admin;

DROP POLICY IF EXISTS notification_deliveries_platform_admin_write ON platform.notification_deliveries;
CREATE POLICY notification_deliveries_platform_admin_write ON platform.notification_deliveries
  FOR INSERT TO taskflow_platform_admin
  WITH CHECK (true);
