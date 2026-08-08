-- 0034 — Phase 7 (Voice & Messaging) Wave 3: SMS threads, the suppression
-- list, and recordings attachable to Work cards.
-- (PLAN.md §3.4, §8.5; ai/phase-7-voice.md §3.8, §3.9, §7.3, §7.5)
--
-- ==========================================================================
-- 1. A MESSAGE THREAD IS NOT A chat.channels ROW (§3.8)
-- ==========================================================================
--
-- Chat's channel model assumes every participant is an org member with a
-- UserId and a relationship tuple. An SMS thread's other party is a phone
-- number, not an account: there is no UserId to write a `member` tuple for, and
-- no permission question to resolve for someone who was never a principal in
-- this system.
--
-- Forcing one into chat.channels would mean either inventing a fake membership
-- for a non-user, or weakening chat.channels' invariants for one row type.
-- Both are the modelling mismatch docs.comments avoided by NOT reusing
-- work.card_comments wholesale.
--
-- So threads get their own table, and the Chat INBOX reads both — a read-side
-- aggregation, not a write-side reuse. `chat:read` does not apply here;
-- `sms:read`/`sms:send` (in the permission catalog since Phase 2) gate it.
--
-- ==========================================================================
-- 2. WHATSAPP IS DEFERRED, BUT THE COLUMN IS NOT (§7.3)
-- ==========================================================================
--
-- Resolved: SMS ships alone, because WhatsApp Business API access needs Meta
-- approval that nothing in this codebase controls, and Wave 1 is built entirely
-- on test credentials so a WhatsApp path could not be exercised end to end
-- anyway.
--
-- `channel` exists NOW with a CHECK that today allows only 'sms'. Adding
-- WhatsApp later widens one CHECK — it is not a migration that has to
-- retrofit a discriminator onto rows that never had one.
--
-- ==========================================================================
-- 3. COUNTERPARTY NUMBERS ARE ENCRYPTED, AS IN 0033
-- ==========================================================================
--
-- Same two-column treatment and the same reasoning as comms.calls: a randomized
-- ciphertext nobody can read, plus a keyed one-way `_index` supporting equality
-- so an inbound message can find its existing thread. Threading is precisely
-- the lookup that makes the blind index necessary rather than decorative.

-- --------------------------------------------------------------------------
-- comms.message_threads — one per (org, our number, their number, channel)
-- --------------------------------------------------------------------------
CREATE TABLE comms.message_threads (
  id                      uuid        PRIMARY KEY,
  org_id                  uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  channel                 text        NOT NULL DEFAULT 'sms',
  phone_number_id         uuid        NOT NULL,

  counterparty_ciphertext bytea       NOT NULL,
  counterparty_index      bytea       NOT NULL,

  last_message_at         timestamptz,
  -- Denormalized unread count for the inbox. Recomputed, never incremented —
  -- work/counters.ts' own reasoning: an increment that is wrong produces a
  -- number nothing ever corrects, and a wrong badge looks exactly like a right
  -- one.
  unread_count            integer     NOT NULL DEFAULT 0,

  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_threads_channel_valid CHECK (channel IN ('sms')),
  CONSTRAINT message_threads_unread_nonnegative CHECK (unread_count >= 0),

  FOREIGN KEY (org_id, phone_number_id)
    REFERENCES comms.phone_numbers (org_id, id) ON DELETE CASCADE
);

-- THE threading key. Without this unique index two inbound messages arriving
-- close together each create their own thread — a race whose symptom is a
-- duplicated conversation in the inbox, which reads as a UI bug rather than a
-- missing constraint.
CREATE UNIQUE INDEX message_threads_participant_key
  ON comms.message_threads (org_id, phone_number_id, counterparty_index, channel);

CREATE UNIQUE INDEX message_threads_org_id_key ON comms.message_threads (org_id, id);

CREATE INDEX message_threads_inbox_idx
  ON comms.message_threads (org_id, last_message_at DESC);

-- --------------------------------------------------------------------------
-- comms.messages
--
-- The BODY is stored in plaintext, unlike the counterparty number, and the
-- difference is worth stating rather than leaving as an inconsistency.
--
-- A phone number is an identifier for a person that is useful to an attacker on
-- its own and appears in a predictable format — it is the field a bulk dump is
-- monetized through. A message body is content the org itself needs to read,
-- search (Phase 8), and render on every inbox load; encrypting it would mean
-- decrypting every row on every list query and would make search impossible
-- without a second index that leaks more than the ciphertext protects.
--
-- The protection for a body is RLS plus `sms:read`, which is the same
-- protection chat.messages has. Applying a stricter rule here than to the
-- chat message next to it in the same inbox would be inconsistent in the
-- unhelpful direction.
-- --------------------------------------------------------------------------
CREATE TABLE comms.messages (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  thread_id        uuid        NOT NULL,

  direction        text        NOT NULL,
  body             text        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  provider_sid     text,
  segments         integer     NOT NULL DEFAULT 1,

  sent_by          uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  error_code       text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,

  CONSTRAINT messages_direction_valid CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT messages_status_valid CHECK (
    status IN ('queued', 'sent', 'delivered', 'undelivered', 'failed', 'received')
  ),
  CONSTRAINT messages_body_length CHECK (length(body) <= 4000),
  CONSTRAINT messages_segments_positive CHECK (segments >= 1),

  FOREIGN KEY (org_id, thread_id)
    REFERENCES comms.message_threads (org_id, id) ON DELETE CASCADE
);

-- Durable idempotency for delivery callbacks, exactly as comms.calls has.
CREATE UNIQUE INDEX messages_provider_sid_key ON comms.messages (org_id, provider_sid)
  WHERE provider_sid IS NOT NULL;

CREATE INDEX messages_thread_idx ON comms.messages (org_id, thread_id, created_at DESC);

-- --------------------------------------------------------------------------
-- comms.suppressions — STOP/UNSUBSCRIBE, honored permanently (§8.5)
--
-- PLAN.md §8.5: "STOP/UNSUBSCRIBE honored automatically and permanently at org
-- level; suppression list checked before every send."
--
-- Three things about this table are deliberate:
--
--   * ORG-LEVEL, not thread-level. Someone who texts STOP has opted out of
--     hearing from the ORGANIZATION, not from one phone number of theirs.
--     Keying it on the thread would let the next number the org buys start
--     messaging them again, which is precisely the thing the law forbids.
--
--   * NO expiry column, and no DELETE in the application. "Permanently" is the
--     requirement. A row here can only be removed by an explicit, audited
--     opt-back-in (a START/UNSTOP message from the same number), which is
--     modelled as `revoked_at` rather than a delete so the record of the
--     original opt-out survives.
--
--   * Indexed by the blind index, like every other counterparty lookup — the
--     check runs before EVERY send, so it has to be an index scan on a column
--     that does not hold the number in plaintext.
-- --------------------------------------------------------------------------
CREATE TABLE comms.suppressions (
  id                      uuid        PRIMARY KEY,
  org_id                  uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  counterparty_ciphertext bytea       NOT NULL,
  counterparty_index      bytea       NOT NULL,

  -- What the person actually sent, for a compliance reviewer.
  reason                  text        NOT NULL DEFAULT 'stop_keyword',
  suppressed_at           timestamptz NOT NULL DEFAULT now(),
  -- Set by an explicit opt-back-in. The row is never deleted.
  revoked_at              timestamptz,

  CONSTRAINT suppressions_reason_valid CHECK (
    reason IN ('stop_keyword', 'manual', 'carrier_report')
  )
);

-- One live suppression per number per org. Partial so a revoked row does not
-- block a later re-suppression by the same person.
CREATE UNIQUE INDEX suppressions_live_key
  ON comms.suppressions (org_id, counterparty_index)
  WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- comms.recording_cards — recordings attached to Work cards (§3.9, §7.5)
--
-- Resolved: MANY. One sales call legitimately relates to several cards, and a
-- join table costs one extra table where a nullable FK would force a choice the
-- user has to undo.
--
-- §3.9's point is that the FK is the enforcement, not a service-level lookup
-- that a second call site could forget: both sides carry org_id and reference
-- COMPOSITE keys, so a recording can never be attached to another tenant's card
-- — or to a card in this tenant that the recording's own org does not match —
-- even if application code got it wrong.
--
-- Reading a card's recordings is `card:read` AND `recording:read`, checked
-- separately. Being allowed to see the card does not by itself disclose a
-- recording someone without `recording:read` should not hear.
-- --------------------------------------------------------------------------
CREATE TABLE comms.recording_cards (
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  recording_id uuid        NOT NULL,
  card_id      uuid        NOT NULL,

  attached_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  attached_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, recording_id, card_id),

  FOREIGN KEY (org_id, recording_id)
    REFERENCES comms.recordings (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, card_id)
    REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

CREATE INDEX recording_cards_card_idx ON comms.recording_cards (org_id, card_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE comms.message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.message_threads FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_threads_tenant_isolation ON comms.message_threads;
CREATE POLICY message_threads_tenant_isolation ON comms.message_threads
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_tenant_isolation ON comms.messages;
CREATE POLICY messages_tenant_isolation ON comms.messages
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.suppressions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS suppressions_tenant_isolation ON comms.suppressions;
CREATE POLICY suppressions_tenant_isolation ON comms.suppressions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE comms.recording_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.recording_cards FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recording_cards_tenant_isolation ON comms.recording_cards;
CREATE POLICY recording_cards_tenant_isolation ON comms.recording_cards
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
