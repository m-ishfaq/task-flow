-- 0071 — notify a member when they are added to an org, or their role changes
--
-- `tenancy/member.service.ts`'s `addMember` and `changeRole` have always
-- written `member.added`/`member.role_changed` to the outbox for the audit
-- log, but `platform/notification.projection.ts`'s `planNotifications`
-- switch never had a case for either — so being added to an org, or having
-- your role changed, produced an audit-log row and nothing else: no in-app
-- notification, no email. This is the 0027/0042/0049 pattern (a CHECK swap,
-- never an enum) widening both constraints so the projection can write these
-- kinds and a new subject type for them.
--
-- Both kinds are `direct` in notification-prefs.ts's category table, not
-- `activity` — this is a fact about YOUR OWN standing in the org, not
-- somebody else's activity, and the difference between the two categories is
-- exactly that (the same reasoning `call.missed` already gives).
--
-- The subject is the MEMBERSHIP, not the org or the user — `subject_id`
-- carries `membershipId`, which is what lets a later membership event for the
-- same person coexist with this one under the existing
-- (org_id, subject_id, user_id, kind) idempotency index without colliding.

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

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call', 'webhook', 'membership'));
