-- 0072 — notify a member when they are removed from an org
--
-- The third membership event in this family, after migration 0071's
-- member.added/member.role_changed. `tenancy/member.service.ts`'s
-- `removeMember` has always written `member.removed` to the outbox for the
-- audit log; `platform/notification.projection.ts`'s `planNotifications`
-- switch never had a case for it either. Same CHECK-swap pattern, a
-- separate migration rather than amending 0071 — migrations are never
-- edited once committed, per this repo's own convention.
--
-- `direct` category, same reasoning as the other two: this is a fact about
-- YOUR OWN standing, not somebody else's activity, and a day-late digest
-- entry saying "you were removed from this org three days ago" is useless.
--
-- The subject is still `membership` — the row is gone from `identity.
-- memberships` by the time this fires, so `subject_id` carries the (now
-- historical) membershipId as a snapshot, the same way every other
-- notification here never re-reads its live subject.

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
      'member.added', 'member.role_changed', 'member.removed'
    ));
