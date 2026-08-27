-- Drops the policies only. The backfilled outbox_dispatch rows stay — they
-- record a true fact (this consumer gave up on these events) independent of
-- whether the policies exist, the same reason 0030's down does not try to
-- undo its own backfill INSERT either.

DROP POLICY IF EXISTS outbox_dispatch_call_wake_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_call_wake_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_call_wake_update ON platform.outbox_dispatch;
