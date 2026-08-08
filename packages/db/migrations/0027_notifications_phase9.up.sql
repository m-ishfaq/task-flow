-- 0027 — Phase 9 (Notifications) Wave 1: preferences, delivery tracking,
-- and the Work/Docs kinds platform.notifications was left room for.
-- (PLAN.md §13 row 9; ai/phase-9-notifications.md §3.1-§3.3)
--
-- ==========================================================================
-- WHY THIS EXTENDS 0022 RATHER THAN REPLACING IT
-- ==========================================================================
--
-- 0022's own header said Phase 9 was expected to ADD to platform.notifications
-- rather than replace it, and left two things unused for exactly this: the
-- `kind` CHECK (not an enum, so widening it is one constraint swap) and the
-- `subject_type` CHECK, which already allows 'card' and 'page' alongside
-- 'message' with nothing ever having written them. Both are used here.
--
-- ==========================================================================
-- notifications.board_id — a second navigation column, alongside channel_id
-- ==========================================================================
--
-- The board route is `/boards/$boardId?card=$cardId` (apps/web/src/router.tsx)
-- -- boardId is a path param, not derivable from cardId alone client-side, so
-- a card notification needs it stored the same way a chat notification already
-- stores channel_id. Docs needs no equivalent: `/docs?page=$pageId` opens a
-- page from its id alone, so page notifications navigate on subject_id with
-- nothing extra. No FK, same reasoning channel_id already documents: a board
-- can be archived without erasing the record that someone was told something.

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention'
    ));

ALTER TABLE platform.notifications
  ADD COLUMN board_id uuid;

-- --------------------------------------------------------------------------
-- Preferences — a category x channel matrix, absence means the coded default
-- (ai/phase-9-notifications.md §3.3). Two categories, not one row per kind:
-- a kind is added to a category in code, never by a migration touching this
-- table.
--
-- GLOBAL PER USER, NOT PER ORG — and in `identity`, not `platform`, because
-- of it. `platform.notifications` is genuinely per-org (an org's Work/Chat/
-- Docs activity produces it), but a DELIVERY preference is the same shape as
-- `identity.users.display_name`: "yours alone... the same wherever you sign
-- in" (`ai/account-page.md`). The alternative — keying this on `org_id` too
-- — was the original draft, and it did not survive contact with the router:
-- every route reading it would need to be `selfRoute` (no permission
-- describes "manage your own preferences", and a guest must be able to) —
-- but `selfRoute` resolves NO org (`ai/account-page.md`'s whole design), so
-- an org-keyed row would have had no org to key it BY. Global-per-user
-- resolves the contradiction rather than working around it.
-- --------------------------------------------------------------------------
CREATE TABLE identity.notification_prefs (
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  category    text        NOT NULL,
  channel     text        NOT NULL,
  enabled     boolean     NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, category, channel),

  CONSTRAINT notification_prefs_category_valid CHECK (category IN ('direct', 'activity')),
  CONSTRAINT notification_prefs_channel_valid  CHECK (channel  IN ('email', 'push', 'sms'))
);

ALTER TABLE identity.notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.notification_prefs FORCE  ROW LEVEL SECURITY;

-- Keyed on app.user_id, not app.org_id — the identical pair
-- `memberships_self_read`/`orgs_self_read` already use (CLAUDE.md, Phase 2),
-- and safe for the same class of reason `withUserScope` itself gives: unlike
-- inserting an OWNER membership naming yourself (what that pair's own
-- caution is about), a member writing their own `enabled` boolean is not a
-- privilege escalation, so this pair gets a real WITH CHECK on the write
-- side rather than being read-only.
CREATE POLICY notification_prefs_self_read ON identity.notification_prefs
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY notification_prefs_self_write ON identity.notification_prefs
  FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY notification_prefs_self_update ON identity.notification_prefs
  FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- The notification projection (running as taskflow_audit, which sets neither
-- app.org_id nor app.user_id — see 0022's own note on why) must consult a
-- recipient's preferences before deciding whether to email them. Read-only:
-- taskflow_audit never writes a preference, a person does.
GRANT SELECT ON identity.notification_prefs TO taskflow_audit;

CREATE POLICY notification_prefs_audit_read ON identity.notification_prefs
  FOR SELECT TO taskflow_audit
  USING (true);

-- --------------------------------------------------------------------------
-- Delivery tracking — one row per (notification, channel), separate from
-- platform.notifications.read_at (ai/phase-9-notifications.md §3.2). The
-- in-app channel gets no row here: the notifications insert itself IS the
-- in-app delivery.
-- --------------------------------------------------------------------------
CREATE TABLE platform.notification_deliveries (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  notification_id   uuid        NOT NULL REFERENCES platform.notifications (id) ON DELETE CASCADE,

  channel           text        NOT NULL,
  status            text        NOT NULL DEFAULT 'pending',
  -- Set only when status = 'suppressed'. A decision, not silence — see
  -- ai/phase-9-notifications.md §3.2.
  reason            text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_deliveries_channel_valid CHECK (channel IN ('email', 'push', 'sms')),
  CONSTRAINT notification_deliveries_status_valid
    CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  CONSTRAINT notification_deliveries_reason_valid
    CHECK (reason IS NULL OR reason IN ('quiet_hours', 'pref_disabled', 'digest_pending', 'no_provider')),

  -- One delivery attempt per notification per channel. Wave 1 always writes
  -- this row in the same transaction as the notification itself, so a
  -- redelivered outbox batch (the projection is at-least-once, see 0022)
  -- conflicts here exactly the way notifications_event_user_key already
  -- makes the notification row itself idempotent.
  CONSTRAINT notification_deliveries_once UNIQUE (notification_id, channel)
);

CREATE INDEX notification_deliveries_notification_idx
  ON platform.notification_deliveries (notification_id);

-- The digest sweep's query (Wave 2): this user's still-pending activity
-- deliveries on the email channel.
CREATE INDEX notification_deliveries_pending_idx
  ON platform.notification_deliveries (org_id, user_id, channel)
  WHERE status = 'pending';

ALTER TABLE platform.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.notification_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_deliveries_tenant_isolation ON platform.notification_deliveries
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Written by the notification projection, exactly like platform.notifications
-- itself (0022's notifications_projection_write policy) and for the same
-- reason: taskflow_audit sets no app.org_id, so it needs its own permissive
-- policy rather than matching the tenant-isolation one above.
GRANT SELECT, INSERT, UPDATE ON platform.notification_deliveries TO taskflow_audit;

CREATE POLICY notification_deliveries_projection_write ON platform.notification_deliveries
  TO taskflow_audit
  USING (true)
  WITH CHECK (true);

-- --------------------------------------------------------------------------
-- The projection needs a recipient's email address to hand to packages/mail,
-- and identity.users carries password_hash on the same row. A column-level
-- grant, mirroring migration 0025's taskflow_backlinks grant on
-- docs.page_versions (which excludes `state` for the identical reason): the
-- role that discovers who to email should not be handed more than that.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity TO taskflow_audit;
GRANT SELECT (id, email, display_name) ON identity.users TO taskflow_audit;
