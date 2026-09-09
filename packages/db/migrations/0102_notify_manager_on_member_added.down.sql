-- 0102 down — drop the manager grant/policy, restore 0083's CHECK (no
-- 'member.report_joined').
--
-- USAGE ON SCHEMA people is NOT revoked here: 0088 already granted it to
-- taskflow_audit for a different table (people.profiles) in this same
-- schema, and this migration's own up.sql only re-states that grant rather
-- than being its sole source — revoking it would break 0087/0088's own
-- feature (actor names in notification titles), which does not belong to
-- this migration to undo.

DROP POLICY IF EXISTS membership_profiles_audit_read ON people.membership_profiles;
REVOKE SELECT (org_id, user_id, manager_user_id) ON people.membership_profiles FROM taskflow_audit;

-- A row this migration's own feature wrote (kind = 'member.report_joined')
-- has no narrower value to demote to once the CHECK below is restored — the
-- identical 0072/0083 shape, for the identical FORCE ROW LEVEL SECURITY
-- reason (0022, applying to the table owner too): lifted for one statement,
-- restored immediately after.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications WHERE kind = 'member.report_joined';

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
      'member.added', 'member.role_changed', 'member.removed',
      'operator_broadcast'
    ));
