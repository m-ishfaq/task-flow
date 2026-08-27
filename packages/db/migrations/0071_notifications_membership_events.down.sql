-- 0071 down — restore the pre-membership-events CHECK constraints (0049's state).
--
-- Rows this migration's own feature wrote (kind IN ('member.added',
-- 'member.role_changed'), subject_type = 'membership') have no narrower
-- value to demote to once the CHECKs below are restored — see 0083's
-- down.sql for the full account of why this needs NO FORCE/FORCE bracketing
-- rather than a plain DELETE: platform.notifications is FORCE ROW LEVEL
-- SECURITY (0022), which applies row security to the table OWNER too, and
-- the only policy admitting taskflow_migrator here is scoped by
-- app.org_id — unset during a migration, so an unbracketed DELETE silently
-- matches zero rows. A single kind-based filter covers both constraints:
-- 'membership' is the subject_type of every member.added/role_changed row
-- (notification.projection.ts), and 0072's own down (which runs before
-- this one) has already cleared member.removed, the only other kind ever
-- paired with it.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications WHERE kind IN ('member.added', 'member.role_changed');

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
      'webhook.disabled'
    ));

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call', 'webhook'));
