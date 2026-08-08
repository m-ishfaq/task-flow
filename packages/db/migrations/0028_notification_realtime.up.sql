-- 0028 — lets the notification projection emit a second-order event
-- (ai/phase-9-notifications.md §3.5).
--
-- ==========================================================================
-- WHY taskflow_audit NEEDS INSERT ON platform.outbox
-- ==========================================================================
--
-- The personal realtime room (`user:{userId}`) is driven the same way every
-- other room is: apps/realtime's existing `'realtime'` outbox consumer,
-- routing on a fixed event->room table (`event-rooms.ts`'s `roomUserIdOf`,
-- structurally identical to `roomBoardIdOf`). That means something has to
-- WRITE a `notification.created` row to `platform.outbox` — and the only
-- process that knows a notification was just created is the projection
-- itself, running as `taskflow_audit`, inside the same transaction that
-- inserts the `platform.notifications` row.
--
-- `platform.outbox`'s existing RLS policy (migration 0002 or thereabouts)
-- requires `app.org_id` to be set and matching (`appendToOutbox`'s own
-- comment: "the RLS WITH CHECK... rejects any event whose orgId differs from
-- the scope"). `taskflow_audit` sets NEITHER `app.org_id` NOR `app.user_id`
-- (0022's own note on why), so without a policy naming it explicitly, this
-- INSERT is refused — the same shape of gap 0016's `outbox_dispatch`
-- policies existed to close for the realtime relay's own writes.
--
-- Scoped to INSERT only, unlike `notifications_projection_write` and
-- `notification_deliveries_projection_write` (which also need UPDATE):
-- the projection never reads or amends an outbox row it wrote, only
-- appends. A second-order event this narrow is the accepted tradeoff
-- `ai/phase-9-notifications.md` §3.5 names explicitly — "a consumer
-- producing an event about its own write, which has no precedent in this
-- codebase yet" — and the grant is scoped as tightly as the one new
-- capability requires, not widened generally.
GRANT INSERT ON platform.outbox TO taskflow_audit;

CREATE POLICY outbox_notification_projection_insert ON platform.outbox
  FOR INSERT TO taskflow_audit
  WITH CHECK (true);
