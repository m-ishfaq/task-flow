-- 0022 — saved messages, and notifications for chat
-- (PLAN.md §3.2, §10.6; ai/phase-5-chat.md §2, §4)
--
-- Two tables that look unrelated and are both "a row per person per thing they
-- care about". They share a migration because they share that shape and because
-- both are read by the same surfaces.
--
-- ==========================================================================
-- WHY NOTIFICATIONS EXIST HERE AND NOT IN PHASE 9
-- ==========================================================================
--
-- PLAN.md puts the notification SYSTEM — digests, per-channel preferences,
-- email and push delivery, the whole preference matrix — in a later phase, and
-- that is still where it belongs. What this table is, deliberately, is the
-- narrow thing chat cannot work without: an in-app record that somebody was
-- mentioned or sent a direct message, so the next time they look they can find
-- out without opening every channel.
--
-- The distinction matters because the temptation is to build the general system
-- now and have chat be its first caller. That gets the dependency backwards: the
-- general system needs to know about digests, quiet hours, and channels this
-- phase has no opinion about, and designing those against one caller produces
-- abstractions that fit only that caller.
--
-- So `platform.notifications` is deliberately minimal, and Phase 9 is expected
-- to ADD to it (a `channel` column for email/push, a preferences table, a
-- `read_at` sweep) rather than replace it. Nothing here forecloses that.
--
-- ==========================================================================
-- THE ROW IS PER RECIPIENT, NOT PER EVENT
-- ==========================================================================
--
-- One `message.sent` naming three people produces THREE rows. The obvious
-- alternative — one row with a recipients array — makes "mark as read" a
-- rewrite of a shared row, so two people reading at once lose one of the two
-- updates, and it makes "my unread notifications" a query that cannot use an
-- index. A row per person per notification is boring and correct.

-- --------------------------------------------------------------------------
-- Saved messages — "save this for later", per person.
--
-- Not a pin. A pin is CHANNEL state that everyone sees and that needs
-- `channel:manage`-adjacent judgment; a save is personal and invisible to
-- everyone else. They are separate tables because merging them would mean one
-- row whose audience depends on a column, and the read paths would have to
-- filter on it correctly every single time.
-- --------------------------------------------------------------------------
CREATE TABLE chat.saved_messages (
  org_id      uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  channel_id  uuid        NOT NULL,
  message_id  uuid        NOT NULL,

  saved_at    timestamptz NOT NULL DEFAULT now(),

  -- One save per person per message. Saving twice is idempotent rather than an
  -- error — a double-click is not something to report.
  PRIMARY KEY (org_id, user_id, message_id),

  -- Composite, so a save cannot point at a message in another channel — the
  -- same reasoning as `messages_parent_fk` in 0017. RLS keeps this inside a
  -- tenant and says nothing about which channel.
  CONSTRAINT saved_messages_message_fk
    FOREIGN KEY (org_id, channel_id, message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

-- "My saved messages", newest first — the only query this table serves.
CREATE INDEX saved_messages_user_idx
  ON chat.saved_messages (org_id, user_id, saved_at DESC);

-- --------------------------------------------------------------------------
-- Notifications
-- --------------------------------------------------------------------------
CREATE TABLE platform.notifications (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- Who is being told.
  user_id       uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- 'chat.mention'      — somebody @mentioned them in a channel.
  -- 'chat.direct'       — a message arrived in a DM they are part of.
  -- 'chat.thread_reply' — a reply landed on a message they wrote.
  --
  -- A CHECK rather than an enum, for the reason 0017 gives: adding a value to
  -- an enum is a harder migration than it needs to be, and Phase 9 will add
  -- several.
  kind          text        NOT NULL,

  -- Polymorphic, exactly like `platform.attachments`. No foreign key: a
  -- notification about a message must survive that message being deleted —
  -- otherwise a retention sweep silently erases the record that somebody was
  -- told something, which is the opposite of what a notification is for.
  subject_type  text        NOT NULL,
  subject_id    uuid        NOT NULL,

  -- Where opening this notification navigates. No FK, same reasoning as
  -- subject_id: a channel can be archived, or a message retained-away,
  -- without erasing the record that someone was told something. Null for a
  -- notification kind with no single channel — none exist yet; every kind
  -- today is chat-originated.
  channel_id    uuid,

  -- Enough to render the row without reading the subject. A notification list
  -- showing fifty items must not be fifty joins into channels and messages the
  -- reader may no longer have access to — and MUST NOT re-disclose content from
  -- a channel they were since removed from. The excerpt is a snapshot of what
  -- they were entitled to see at the moment they were told.
  title         text        NOT NULL,
  excerpt       text,

  -- Who caused it. Null for anything a job produced.
  actor_id      uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_kind_valid
    CHECK (kind IN ('chat.mention', 'chat.direct', 'chat.thread_reply')),

  CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page')),

  CONSTRAINT notifications_title_length   CHECK (length(title) <= 200),
  CONSTRAINT notifications_excerpt_length CHECK (excerpt IS NULL OR length(excerpt) <= 300)
);

-- The bell: this person's notifications, newest first, unread ones first found.
CREATE INDEX notifications_user_idx
  ON platform.notifications (org_id, user_id, created_at DESC);

-- The badge count, which is the query that runs on every page load. Partial on
-- unread so it scans only what it counts.
CREATE INDEX notifications_unread_idx
  ON platform.notifications (org_id, user_id)
  WHERE read_at IS NULL;

-- One notification per person per event. The projection is an at-least-once
-- outbox consumer (`outbox_dispatch` gives each consumer its own claim), so it
-- CAN redeliver a batch after a crash — this is what makes that harmless
-- instead of duplicating somebody's bell.
CREATE UNIQUE INDEX notifications_event_user_key
  ON platform.notifications (org_id, subject_id, user_id, kind);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
--
-- Note what these do NOT do: they scope to the ORG, not to the user. "Only my
-- own notifications" is the service's WHERE clause, not a policy — the same
-- division every other table here uses, because a per-user policy would need
-- `app.user_id` set on the normal org-scoped path, which it deliberately is not
-- (CLAUDE.md, Phase 2: only two policies consult it, both FOR SELECT).
-- --------------------------------------------------------------------------

ALTER TABLE chat.saved_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.saved_messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_messages_tenant_isolation ON chat.saved_messages;
CREATE POLICY saved_messages_tenant_isolation ON chat.saved_messages
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE platform.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.notifications FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_tenant_isolation ON platform.notifications;
CREATE POLICY notifications_tenant_isolation ON platform.notifications
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The notification projection runs as the AUDIT role, like the audit projection
-- does, because both are outbox consumers that write on behalf of the system
-- rather than on behalf of a request. It therefore needs its own grant.
GRANT SELECT, INSERT, UPDATE ON platform.notifications TO taskflow_audit;

-- ...and a policy that applies to that role. `taskflow_audit` sets no
-- `app.org_id`, so the tenant policy above matches nothing for it; this one
-- lets the projection write the org named on the row it is projecting.
--
-- 0015's closing comment says exactly what a new consumer costs: "grant that
-- role SELECT/INSERT/UPDATE on platform.outbox_dispatch and its own three
-- policies scoped to its own consumer name." `taskflow_audit` already holds
-- the table-level GRANT (0015) — shared across every consumer that role ever
-- serves — but 0015's own outbox_dispatch_audit_read/insert/update policies
-- are `USING/WITH CHECK (consumer = 'audit')`, which does not cover this
-- projection claiming and marking rows under `consumer = 'notifications'`.
-- Without these three, `markDispatched` for this consumer is refused by RLS
-- ("new row violates row-level security policy for table outbox_dispatch"),
-- inside the SAME transaction that already inserted the notification rows —
-- so the whole tick rolls back, the notification never exists, and
-- `claimPending` reclaims the identical batch every 5s forever, since RLS
-- silently hides the fact those rows were ever attempted rather than erroring
-- on the claim itself. Mirrors 0016's outbox_dispatch_realtime_* exactly,
-- just against the audit role rather than a dedicated one.
DROP POLICY IF EXISTS outbox_dispatch_notifications_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_notifications_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_audit
  USING (consumer = 'notifications');

DROP POLICY IF EXISTS outbox_dispatch_notifications_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_notifications_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_audit
  WITH CHECK (consumer = 'notifications');

DROP POLICY IF EXISTS outbox_dispatch_notifications_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_notifications_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_audit
  USING (consumer = 'notifications')
  WITH CHECK (consumer = 'notifications');

DROP POLICY IF EXISTS notifications_projection_write ON platform.notifications;
CREATE POLICY notifications_projection_write ON platform.notifications
  TO taskflow_audit
  USING (true)
  WITH CHECK (true);
