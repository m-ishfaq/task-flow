-- 0072 down — restore 0071's CHECK (member.added/member.role_changed, no member.removed).
--
-- A row this migration's own feature wrote (kind = 'member.removed') has no
-- narrower value to demote to once the CHECK below is restored — the same
-- gap 0083's down.sql shipped with and had to be fixed twice: once for the
-- missing DELETE, once more because platform.notifications is FORCE ROW
-- LEVEL SECURITY (0022), which applies row security to the table OWNER too.
-- taskflow_migrator owns it and is NOBYPASSRLS, and the only policy that
-- applies to it here, notifications_tenant_isolation, is scoped by
-- app.org_id — unset during a migration. Left as FORCE, this DELETE would
-- silently match zero rows against a database that genuinely has
-- member.removed rows across several orgs. Lifted for this one statement
-- and restored immediately after, mirroring 0015's own bracketing on
-- platform.outbox. notification_deliveries needs no matching DELETE: its
-- FK (0027) cascades on delete.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications WHERE kind = 'member.removed';

ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;

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
      'member.added', 'member.role_changed'
    ));
