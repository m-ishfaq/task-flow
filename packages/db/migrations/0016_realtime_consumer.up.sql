-- 0016 — the realtime consumer (ai/phase-4-realtime.md §3.5, §7.3)
--
-- Migration 0015 built the fan-out table and its closing comment specified
-- exactly what adding a consumer costs: "grant that role SELECT/INSERT/UPDATE
-- on platform.outbox_dispatch and its own three policies scoped to its own
-- consumer name". This is that, for 'realtime', plus the NOTIFY trigger §7.3
-- decided on. No new tables and no column changes.
--
-- The role itself is created in docker/postgres/init/02-roles.sql, not here —
-- roles are cluster-wide and migrations run as taskflow_migrator, which is
-- NOCREATEROLE on purpose. A database whose volume predates that file will fail
-- this migration with "role taskflow_realtime does not exist"; the fix is
-- `docker compose down -v && docker compose up -d`, not loosening the migrator.

-- --------------------------------------------------------------------------
-- Reading the queue.
--
-- Mirrors outbox_relay_read (0006) rather than widening it. Two policies scoped
-- to two roles say "audit may read every org's events, and so may realtime";
-- one policy naming both roles says the same thing today and becomes a place
-- where revoking one consumer's access means editing a predicate that another
-- consumer depends on.
--
-- Both a GRANT and a POLICY for UPDATE here, and neither alone is enough —
-- confirmed against a real database, the hard way. Not for writing a column:
-- nothing this role does touches outbox.published_at or any other field on
-- this table, and its own bookkeeping lives entirely in outbox_dispatch below.
-- It is required because claimPending's claim is
-- `SELECT ... FOR UPDATE OF o SKIP LOCKED`, and Postgres's row-level security
-- for a LOCKING select is not decided by the SELECT policy alone: a row must
-- ALSO pass a policy that applies to UPDATE (or ALL), or it is silently
-- excluded from the lock — not an error, just absent, indistinguishable from
-- an empty queue. `outbox_tenant_isolation` below is exactly such a policy,
-- but it is scoped to the CALLER'S org (`current_setting('app.org_id')`),
-- which this role always runs with cleared (`withRealtimeScope` sets it to
-- ''), so it evaluates false for every row and this role needs its own
-- UPDATE-permitting policy the same way outbox_relay_mark (0006) already
-- gives taskflow_audit one. Two ways this looked fixed and was not, both
-- caught only by seeding a real row and running the exact claim query:
--   1. GRANT SELECT alone: fails at the privilege check itself
--      ("permission denied for table outbox").
--   2. GRANT SELECT, UPDATE with no matching policy: the privilege check
--      passes, `assertRoomTableIsSafe` passes, boot succeeds — and the claim
--      silently returns zero rows, forever, which is indistinguishable from
--      an idle queue with no other signal anywhere.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform TO taskflow_realtime;
GRANT SELECT, UPDATE ON platform.outbox TO taskflow_realtime;

DROP POLICY IF EXISTS outbox_realtime_read ON platform.outbox;
CREATE POLICY outbox_realtime_read ON platform.outbox
  FOR SELECT TO taskflow_realtime
  USING (true);

DROP POLICY IF EXISTS outbox_realtime_mark ON platform.outbox;
CREATE POLICY outbox_realtime_mark ON platform.outbox
  FOR UPDATE TO taskflow_realtime
  USING (true)
  WITH CHECK (true);

-- --------------------------------------------------------------------------
-- Its own dispatch bookkeeping, pinned to its own consumer name.
--
-- The WITH CHECK is the control that makes two consumers safe to run at all. A
-- broadcaster that passed 'audit' to markDispatched would otherwise erase an
-- event from the AUDIT relay's queue — a compliance record silently missing an
-- entry, caused by a typo in a string literal in a different app. Here the
-- database refuses it.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON platform.outbox_dispatch TO taskflow_realtime;

DROP POLICY IF EXISTS outbox_dispatch_realtime_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_realtime_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_realtime
  USING (consumer = 'realtime');

DROP POLICY IF EXISTS outbox_dispatch_realtime_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_realtime_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_realtime
  WITH CHECK (consumer = 'realtime');

DROP POLICY IF EXISTS outbox_dispatch_realtime_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_realtime_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_realtime
  USING (consumer = 'realtime')
  WITH CHECK (consumer = 'realtime');

-- --------------------------------------------------------------------------
-- Waking the relay (§7.3).
--
-- The audit relay's five-second tick was chosen for a compliance record, where
-- lag is invisible. Realtime is the channel where lag IS the feature.
--
-- WHAT THIS IS NOT: a delivery mechanism. NOTIFY is fire-and-forget — nothing
-- queues it for a listener that is disconnected, and a listener that drops for
-- two seconds misses everything sent in that window with no way to discover it
-- did. A gateway that woke only on notification would lose events precisely
-- when it had just recovered from a problem.
--
-- So the poll stays, and stays lazy (5s), as the correctness floor: the drain
-- path is unchanged, and a missed notification costs latency rather than an
-- event. This trigger only makes the common case fast.
--
-- Fired per STATEMENT, not per row. A mutation emitting three events is one
-- wake-up, because the listener's response to any number of notifications is
-- the same single drain — and pg_notify de-duplicates identical payloads within
-- a transaction anyway, which is a coincidence to not depend on.
--
-- The payload is deliberately empty. A payload carrying the event would make
-- this a delivery channel, with a hard 8000-byte limit and none of the outbox's
-- durability — and would tempt a consumer into broadcasting from it directly,
-- skipping the dispatch bookkeeping that makes redelivery safe. There is
-- exactly one thing a listener may conclude from this notification: "drain
-- now". It re-reads the queue under RLS like every other drain.
--
-- AFTER INSERT, so it fires only on commit: NOTIFY issued inside a transaction
-- is delivered when that transaction commits and discarded if it rolls back,
-- which matches the outbox's own atomicity. A rolled-back mutation cannot wake
-- anyone to look for an event that does not exist.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.notify_outbox_appended() RETURNS trigger
  LANGUAGE plpgsql
  -- SECURITY INVOKER (the default, stated to be explicit): the function does no
  -- table access, so it needs no privileges of its own, and a DEFINER function
  -- owned by the migrator would be a privilege-escalation surface for nothing.
  SECURITY INVOKER
  -- Empty search_path: this body resolves no unqualified names, and pinning it
  -- means a later edit that introduces one cannot be captured by a caller's
  -- search_path.
  SET search_path = ''
AS $$
BEGIN
  PERFORM pg_notify('outbox_appended', '');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS outbox_appended_notify ON platform.outbox;
CREATE TRIGGER outbox_appended_notify
  AFTER INSERT ON platform.outbox
  FOR EACH STATEMENT
  EXECUTE FUNCTION platform.notify_outbox_appended();

-- LISTEN needs no grant — any role may listen on any channel, which is why the
-- payload above carries nothing. The queue itself is still behind RLS: a
-- listener learns only that SOMETHING was appended, and learns what only by
-- reading platform.outbox under a policy that names its role.

-- --------------------------------------------------------------------------
-- The Socket.io Postgres adapter's spill table (§5).
--
-- Wired at single-instance scale on purpose: the adapter is what makes a
-- broadcast reach clients connected to a DIFFERENT gateway instance, and
-- retrofitting it once two instances are already behind a load balancer means
-- discovering the need through users who see half a board update.
--
-- The adapter delivers broadcasts over NOTIFY, which caps a payload at 8000
-- bytes. Anything larger is written here and the notification carries a
-- pointer. So this table holds BROADCAST PACKETS — tenant data, in bytea, for
-- the few seconds before the adapter's own cleanup removes them.
--
-- That is why it gets RLS rather than being treated as scratch space. There is
-- no org_id to scope by (a packet is not a row of any tenant's), so the policy
-- is scoped to the ROLE, the same shape as outbox_dispatch's: only
-- taskflow_realtime may read these bytes. taskflow_app — the role every request
-- in the API runs as, and the one an application-level SQL injection would run
-- as — cannot, which is the property worth having.
--
-- Column names and types are fixed by the adapter, not chosen here.
-- --------------------------------------------------------------------------
CREATE TABLE platform.socket_io_attachments (
  id         bigserial   UNIQUE,
  created_at timestamptz DEFAULT now(),
  payload    bytea
);

ALTER TABLE platform.socket_io_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.socket_io_attachments FORCE  ROW LEVEL SECURITY;

-- DELETE included, unlike anywhere else a consumer role is granted access: the
-- adapter prunes its own spilled payloads on a timer, and rows that outlive
-- their broadcast are tenant data sitting in a table for no reason. This is the
-- one place where "the consumer deletes" is the safer answer.
GRANT SELECT, INSERT, DELETE ON platform.socket_io_attachments TO taskflow_realtime;
GRANT USAGE, SELECT ON SEQUENCE platform.socket_io_attachments_id_seq TO taskflow_realtime;

DROP POLICY IF EXISTS socket_io_attachments_realtime ON platform.socket_io_attachments;
CREATE POLICY socket_io_attachments_realtime ON platform.socket_io_attachments
  FOR ALL TO taskflow_realtime
  USING (true)
  WITH CHECK (true);
