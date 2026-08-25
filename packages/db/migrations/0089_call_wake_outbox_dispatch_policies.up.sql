-- 0089 — the call-wake consumer never got its own outbox_dispatch policies.
--
-- Every OTHER outbox consumer in this codebase — 'audit' (0015), 'realtime'
-- (0016), 'notifications' (0022), 'search' (0045), 'automation' (0047) —
-- ships three RLS policies on `platform.outbox_dispatch` scoped to its own
-- consumer name, layered onto the table-level GRANT its role already holds
-- (0015's own header: "grant that role SELECT/INSERT/UPDATE on
-- platform.outbox_dispatch and its own three policies scoped to its own
-- consumer name"). `call-wake.ts`'s own header claims this cost ("adding
-- 'rtc-call-wake' here needs no migration, no new role, no new grant beyond
-- what taskflow_audit already holds on platform.expo_push_tokens") but the
-- three consumer-scoped policies were never written — `CALL_WAKE_CONSUMER =
-- 'rtc-call-wake'` (packages/db/migrations/*.sql grepped clean) never
-- appears in any migration until this one.
--
-- `claimPending`'s own SELECT tolerates this by accident: it LEFT JOINs
-- outbox_dispatch, and RLS hiding every row for an un-policied consumer
-- looks identical to there being no dispatch row yet — so the first claim
-- of any `rtc_session.started` event always "succeeds" and the drain always
-- reports rows processed. `markDispatched` does not get the same accidental
-- pass: it INSERTs into outbox_dispatch (`onConflictDoUpdate`), which needs
-- a WITH CHECK policy admitting `consumer = 'rtc-call-wake'` — with none,
-- Postgres refuses the write ("new row violates row-level security policy
-- for table outbox_dispatch"), the error propagates out of `drainCallWake`'s
-- `withAuditScope` callback, and the whole batch's SQL transaction rolls
-- back. The event is therefore claimed, re-claimed, and re-attempted on
-- EVERY relay tick forever — visible as `dispatched_at` staying NULL no
-- matter how many times `rtc_session.started` fires, exactly the shape a
-- live query against `platform.outbox`/`outbox_dispatch` showed.
--
-- The real sends already happen before that rollback — `expoPushProvider.
-- send()` and `recordOperationalEvent` both run outside this SQL
-- transaction (a real HTTP call, and a write through `withOpsEventScope`'s
-- OWN connection, respectively) — so this bug was never "no push sent," it
-- was "every push sent 12 times a minute, forever, with the database
-- insisting it was never sent even once." A recipient whose device Expo
-- ultimately throttled or deduplicated could easily see nothing ring at
-- all.

DROP POLICY IF EXISTS outbox_dispatch_call_wake_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_call_wake_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_audit
  USING (consumer = 'rtc-call-wake');

DROP POLICY IF EXISTS outbox_dispatch_call_wake_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_call_wake_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_audit
  WITH CHECK (consumer = 'rtc-call-wake');

DROP POLICY IF EXISTS outbox_dispatch_call_wake_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_call_wake_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_audit
  USING (consumer = 'rtc-call-wake')
  WITH CHECK (consumer = 'rtc-call-wake');

-- One-time backfill, not a rollback target: every `rtc_session.started`
-- event that piled up undispatched while these policies were missing gets
-- marked dispatched here (given up on, never sent) instead of being
-- replayed the moment this migration lands. Without this, the very next
-- relay tick would claim the ENTIRE backlog — every call ever placed since
-- this bug shipped — and fire a burst of "Incoming call" pushes for calls
-- that are, by now, long over. That is the identical judgment call
-- `call-wake.ts`'s own header already makes for a single failed send ("a
-- push that fails is a ring this pass could not deliver, not a ring to
-- attempt again after the call has likely already ended one way or
-- another"), applied once, in bulk, to a backlog that failed for the same
-- underlying reason. Runs as the migrator, which is not subject to
-- `taskflow_audit`'s RLS at all, so it is not circular with the policies
-- just added above.
INSERT INTO platform.outbox_dispatch (event_id, consumer, dispatched_at)
SELECT o.id, 'rtc-call-wake', now()
FROM platform.outbox o
WHERE o.name = 'rtc_session.started'
  AND NOT EXISTS (
    SELECT 1 FROM platform.outbox_dispatch d
    WHERE d.event_id = o.id AND d.consumer = 'rtc-call-wake'
  )
ON CONFLICT (event_id, consumer) DO NOTHING;
