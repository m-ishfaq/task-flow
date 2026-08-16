-- 0074 — per-user message hiding ("remove for me").
--
-- The one row kind in chat that means "this person does not want to see this
-- message", as opposed to "this message is gone". Slack's two-way delete:
-- "remove for me" writes a row HERE and the message stays live for everyone
-- else; "remove for everyone" is the existing tombstone (messages.deleted_at).
--
-- The two are deliberately separate tables/columns rather than one nullable
-- column on chat.messages: a `hidden_by` list on the message row would need a
-- second table anyway (a message can be hidden by many users), and baking the
-- first hidden user into messages would make "removed for me" an UPDATE to a
-- row owned by everyone. A separate table keeps "this user hid this message"
-- a fact scoped to that user, with the same shape as message_reactions:
-- composite FK pinning (org, channel, message) to a real message, so a hide
-- can never name a message in another channel or another tenant.
--
-- RLS is org-isolation only, the same policy message_reactions carries. The
-- user a hide belongs to is NOT in the policy: chat services run inside
-- withOrgScope, which clears app.user_id, so a policy reading app.user_id
-- here would refuse every insert (CLAUDE.md, phase 2 — app.user_id only feeds
-- the two membership self-read policies). Instead the service writes
-- user_of(actor) from the verified token, never from input, and the list
-- filters are keyed on that same actor id — the "can only hide for yourself"
-- invariant is enforced in the service, and RLS keeps the row inside the
-- tenant.
CREATE TABLE chat.message_hidden (
  org_id      uuid        NOT NULL,
  channel_id  uuid        NOT NULL,
  message_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_hidden_message_fk
    FOREIGN KEY (org_id, channel_id, message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

CREATE INDEX message_hidden_user_idx
  ON chat.message_hidden (org_id, user_id, message_id);

ALTER TABLE chat.message_hidden ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.message_hidden FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_hidden_tenant_isolation ON chat.message_hidden;
CREATE POLICY message_hidden_tenant_isolation ON chat.message_hidden
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
