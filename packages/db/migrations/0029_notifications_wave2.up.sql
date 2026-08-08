-- 0029 — Phase 9 (Notifications) Wave 2: web push subscriptions, the
-- due-reminder sweep's dedicated role, and the one grant the projection
-- gains to make the due-date-edit refire work.
-- (ai/phase-9-notifications.md §3.7, §3.8, §5 Wave 2)
--
-- Three things land here, each with its own load-bearing detail.
--
-- ==========================================================================
-- 1. platform.push_subscriptions — a DEVICE row, not a bare credential
-- ==========================================================================
--
-- §3.7 ships this deliberately shaped for Phase 12's device/session
-- inventory screen: `userAgentLabel`, `createdAt` and `lastSeenAt` are the
-- columns that table will read directly, so Phase 12 starts from what this
-- migration leaves behind rather than building a parallel device concept
-- around a narrower `(endpoint, keys)` pair. Nothing in this phase renders a
-- device list — the only consumer of these extra columns is `last_seen_at`,
-- touched by the push relay on every successful send.
--
-- The key material (`endpoint`, `p256dh`, `auth`) is protected by RLS and by
-- being unreachable without a valid session — the §7.3 decision, confirmed
-- 2026-08-08. Envelope-encrypting them with the server's own master key was
-- considered and declined: an attacker who has reached the database far
-- enough to read these rows already holds the VAPID private key the server
-- uses to sign with them, so the encryption would defend against the
-- attacker the system cannot survive anyway. The cost (a wrapped-key column,
-- a second key path in packages/security) buys defense-in-depth against a
-- narrower threat than the one that actually matters.
--
-- The self-scoped policies key on `app.user_id`, the identical pair 0027's
-- `notification_prefs_self_*` policies use and safe for the same reason: a
-- member registering THEIR OWN device row is not a privilege escalation, so
-- the write side gets a real WITH CHECK rather than being read-only.
--
-- taskflow_audit gains SELECT/UPDATE/DELETE — not INSERT — because the only
-- process that reads or amends a subscription is the push relay inside the
-- API, which sends ON BEHALF of a notification (SELECT to read endpoints,
-- UPDATE for `last_seen_at`, DELETE for an endpoint the push service says is
-- gone). Registration is always a person's own action through the
-- application role, which already has default privileges on `platform`
-- tables (0001).
--
-- ==========================================================================
-- 2. taskflow_notification_sweep — the sixth system role
-- ==========================================================================
--
-- The due-reminder scan (§3.8) reads `work.cards` across EVERY tenant in one
-- pass — no value of `app.org_id` is correct for it, exactly like the audit,
-- realtime, and backlinks relays before it. It therefore gets a role of its
-- own rather than widening taskflow_audit, which is the same least-privilege
-- call 0015 and 0025 already made twice, and it is column-limited the way
-- taskflow_backlinks is: the role that discovers WHICH cards are due is
-- granted `(id, org_id, board_id, title, number, due_date, assignee_ids)`
-- and never a column it does not need to make that decision.
--
-- ONE DELIBERATE EXTENSION BEYOND §3.8'S LETTER, made after the plan was
-- written: the sweep also writes `notification_deliveries` rows and reads
-- `notification_prefs`. §3.8's role spec stopped at SELECT/INSERT on
-- platform.notifications, but the sweep is the ONLY writer of
-- `card.due_soon` notifications, and delivery decisions are made at write
-- time (§3.2 — that is the whole point of the deliveries table). Without
-- these two extra grants, a user who enables email for the `activity`
-- category would never get their due reminders in the daily digest, because
-- no pending email-delivery row would ever exist for the digest sweep to
-- collect. The grant is still narrow: SELECT on prefs (never write), INSERT
-- on deliveries (never read, amend, or suppress). Flagged here rather than
-- folded in silently — the wave that adds a role is the wave to widen it
-- deliberately, not to let the next one discover the gap.
--
-- ==========================================================================
-- 3. taskflow_audit gains DELETE on platform.notifications
-- ==========================================================================
--
-- §3.8's one gap: a reminder that already fired must be cleared when the
-- card's due date is edited, so the next scan pass can re-fire against the
-- new date — the unique index would otherwise keep matching and no second
-- reminder would ever arrive. The projection performs that delete on
-- `card.updated` events (§3.8, `notification.projection.ts`). The policy
-- half already exists — 0022's `notifications_projection_write` is a FOR ALL
-- policy covering DELETE — but the GRANT from the same migration lists only
-- SELECT, INSERT, UPDATE, and a policy is no substitute for a grant. This
-- line closes the gap without touching the policy.

-- --------------------------------------------------------------------------
-- Push subscriptions — see note 1 above.
-- --------------------------------------------------------------------------
CREATE TABLE platform.push_subscriptions (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- The browser's subscription endpoint (e.g. an FCM or Mozilla push URL).
  -- The key a subscriber is identified by: unique per (user, endpoint) so a
  -- device re-subscribing is an upsert, not a duplicate row.
  endpoint         text        NOT NULL,
  -- base64url, 65 bytes — the P-256 public key in uncompressed point form.
  p256dh           text        NOT NULL,
  -- base64url, 16 bytes — the subscription's authentication secret.
  auth             text        NOT NULL,

  -- Parsed at registration time into something a person recognizes
  -- ("Chrome on macOS"). Phase 12's device screen reads this directly.
  user_agent_label text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Touched on every successful push. Phase 12's "is this device alive?"
  -- question, answered for free by the relay that is already sending.
  last_seen_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT push_subscriptions_user_endpoint_key UNIQUE (user_id, endpoint)
);

ALTER TABLE platform.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.push_subscriptions FORCE  ROW LEVEL SECURITY;

-- A person's own device rows. Same shape as 0027's notification_prefs
-- self-policies, for the same reason (see note 1): this is personal data
-- about yourself, not a grant of anything.
CREATE POLICY push_subscriptions_self_read ON platform.push_subscriptions
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY push_subscriptions_self_insert ON platform.push_subscriptions
  FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY push_subscriptions_self_update ON platform.push_subscriptions
  FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY push_subscriptions_self_delete ON platform.push_subscriptions
  FOR DELETE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- The push relay. SELECT to read endpoints, UPDATE for last_seen_at, DELETE
-- for endpoints the push service reports gone (404/410 — the browser will
-- never use that endpoint again). Deliberately no INSERT: registration is a
-- person's own act, and the only writer that should ever be able to mint a
-- subscription is the session that proves it is theirs.
GRANT SELECT, UPDATE, DELETE ON platform.push_subscriptions TO taskflow_audit;

CREATE POLICY push_subscriptions_audit_send ON platform.push_subscriptions
  FOR ALL TO taskflow_audit
  USING (true)
  WITH CHECK (true);

-- --------------------------------------------------------------------------
-- taskflow_notification_sweep — see note 2 above.
-- --------------------------------------------------------------------------

-- The scan. Column-level, and deliberately excluding every column the sweep
-- does not need to decide "is this card due, and who should be told": no
-- description, no assignee names, no rank.
--
-- archived_at and deleted_at ARE included, even though the sweep never
-- projects them: the claim query filters on them (`cards_due_idx` is built
-- the same way), and Postgres checks column-level SELECT against every column
-- a WHERE clause mentions, not just the SELECT list. A grant missing them
-- applies, migrates cleanly, and fails at the first real sweep with
-- `permission denied for table cards` — a runtime error no review of the
-- migration text catches.
GRANT USAGE ON SCHEMA work TO taskflow_notification_sweep;
GRANT SELECT (id, org_id, board_id, title, number, due_date, assignee_ids,
              archived_at, deleted_at)
  ON work.cards TO taskflow_notification_sweep;

DROP POLICY IF EXISTS cards_notification_sweep_claim ON work.cards;
CREATE POLICY cards_notification_sweep_claim ON work.cards
  FOR SELECT TO taskflow_notification_sweep
  USING (true);

-- The rows it writes. SELECT as well as INSERT because Postgres requires
-- SELECT privilege on a table before `INSERT ... ON CONFLICT` can check the
-- conflict target — the idempotency mechanism §3.8 relies on.
GRANT USAGE ON SCHEMA platform TO taskflow_notification_sweep;
GRANT SELECT, INSERT ON platform.notifications TO taskflow_notification_sweep;

DROP POLICY IF EXISTS notifications_notification_sweep_select ON platform.notifications;
CREATE POLICY notifications_notification_sweep_select ON platform.notifications
  FOR SELECT TO taskflow_notification_sweep
  USING (true);

DROP POLICY IF EXISTS notifications_notification_sweep_insert ON platform.notifications;
CREATE POLICY notifications_notification_sweep_insert ON platform.notifications
  FOR INSERT TO taskflow_notification_sweep
  WITH CHECK (true);

-- The preference consult — read-only, a person's own rows stay the only
-- writers. See note 2 for why this exists beyond §3.8's letter.
GRANT USAGE ON SCHEMA identity TO taskflow_notification_sweep;
GRANT SELECT ON identity.notification_prefs TO taskflow_notification_sweep;

DROP POLICY IF EXISTS notification_prefs_sweep_read ON identity.notification_prefs;
CREATE POLICY notification_prefs_sweep_read ON identity.notification_prefs
  FOR SELECT TO taskflow_notification_sweep
  USING (true);

-- The delivery rows the digest and push relays act on. INSERT only — the
-- sweep decides a delivery is wanted; the digest and push relays are the
-- ones that advance its state.
GRANT INSERT ON platform.notification_deliveries TO taskflow_notification_sweep;

DROP POLICY IF EXISTS notification_deliveries_sweep_insert ON platform.notification_deliveries;
CREATE POLICY notification_deliveries_sweep_insert ON platform.notification_deliveries
  FOR INSERT TO taskflow_notification_sweep
  WITH CHECK (true);

-- --------------------------------------------------------------------------
-- The projection's due-date-edit clearing — see note 3 above.
-- --------------------------------------------------------------------------
GRANT DELETE ON platform.notifications TO taskflow_audit;
