-- 0018 — chat Wave 2: reactions, pins, read cursors
-- (ai/phase-5-chat.md §5 Wave 2)
--
-- Three small tables, each scoped the same way `messages` is: `channel_id`
-- alone is not enough to keep a row inside the tenant AND the channel it
-- claims to belong to (0017's own note on why RLS cannot see a cross-channel
-- mistake), so each references `chat.messages (org_id, channel_id, id)`
-- composite rather than `messages.id` alone — a reaction, a pin, or a read
-- cursor cannot name a message in a different channel even when the ids are
-- both real.
--
-- None of these gets its own `channel_members`-style table, for the same
-- reason `chat.channels` doesn't: authorization is `can()` asking
-- `message:create` (react, pin) or `channel:read` (mark read) against the
-- channel the message lives in, resolved from the existing membership tuple.
-- A row existing in one of these tables is a fact about what happened, never
-- itself a grant.

-- --------------------------------------------------------------------------
-- Reactions
-- --------------------------------------------------------------------------
CREATE TABLE chat.message_reactions (
  org_id      uuid        NOT NULL,
  channel_id  uuid        NOT NULL,
  message_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- A short unicode string (an emoji, or a `:shortcode:` in a later wave) —
  -- not a foreign key into a fixed reaction-set table. Chat products that
  -- restrict the palette do it in the CLIENT (an emoji picker offers what it
  -- offers); the server's job is bounding length and identity, not curating
  -- taste.
  emoji       text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- One reaction of a given emoji per person per message — clicking the same
  -- emoji you already reacted with is what TOGGLES it off (the service's
  -- job), not a second identical row.
  PRIMARY KEY (message_id, user_id, emoji),

  CONSTRAINT message_reactions_emoji_length CHECK (length(emoji) BETWEEN 1 AND 32),

  CONSTRAINT message_reactions_message_fk
    FOREIGN KEY (org_id, channel_id, message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

-- The reaction bar under a message: every reaction on it, grouped by emoji.
CREATE INDEX message_reactions_message_idx
  ON chat.message_reactions (org_id, message_id);

-- --------------------------------------------------------------------------
-- Pins
-- --------------------------------------------------------------------------
CREATE TABLE chat.pinned_messages (
  org_id      uuid        NOT NULL,
  channel_id  uuid        NOT NULL,
  message_id  uuid        NOT NULL,

  -- Null once the pinner's account is deleted — the pin survives, matching
  -- every other "who did this" column in this schema (`messages.author_id`).
  pinned_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  pinned_at   timestamptz NOT NULL DEFAULT now(),

  -- One pin per message. Pinning an already-pinned message is a no-op the
  -- service answers idempotently, the same way `addChannelMember` does for
  -- an existing member.
  PRIMARY KEY (channel_id, message_id),

  CONSTRAINT pinned_messages_message_fk
    FOREIGN KEY (org_id, channel_id, message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

-- The pinned-messages panel: one channel, newest pin first.
CREATE INDEX pinned_messages_channel_idx
  ON chat.pinned_messages (org_id, channel_id, pinned_at);

-- --------------------------------------------------------------------------
-- Read cursors (ai/phase-5-chat.md §3.6)
--
-- The one write in this phase with a genuinely open cost question, resolved
-- as: its own table, its own service, a typed event for guardrail 11 and
-- unread-badge sync — and that event is EXCLUDED from the audit projection
-- (`apps/api/src/tenancy/audit.projection.ts`'s `NEVER_AUDITED` set), on
-- purpose. A read cursor advances on ordinary scrolling, not a deliberate
-- action, and "user read up to message X" a thousand times a day is not a
-- compliance-relevant fact — it is exactly the write-amplification the audit
-- chain's per-org lock (CLAUDE.md, Phase 2 notes) was never sized for.
-- --------------------------------------------------------------------------
CREATE TABLE chat.read_cursors (
  org_id               uuid        NOT NULL,
  channel_id           uuid        NOT NULL,
  user_id              uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  last_read_message_id uuid        NOT NULL,
  last_read_at         timestamptz NOT NULL DEFAULT now(),

  -- One cursor per person per channel — marking read again just moves it
  -- forward (the service refuses to move it backward; see markRead).
  PRIMARY KEY (channel_id, user_id),

  CONSTRAINT read_cursors_message_fk
    FOREIGN KEY (org_id, channel_id, last_read_message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — identical shape to every tenant table in 0017.
-- --------------------------------------------------------------------------

ALTER TABLE chat.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.message_reactions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_reactions_tenant_isolation ON chat.message_reactions;
CREATE POLICY message_reactions_tenant_isolation ON chat.message_reactions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE chat.pinned_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.pinned_messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pinned_messages_tenant_isolation ON chat.pinned_messages;
CREATE POLICY pinned_messages_tenant_isolation ON chat.pinned_messages
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE chat.read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.read_cursors FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_cursors_tenant_isolation ON chat.read_cursors;
CREATE POLICY read_cursors_tenant_isolation ON chat.read_cursors
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
