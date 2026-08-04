-- 0014 — the outbox fan-out seam (PLAN.md §10.6, Phase 4)
--
-- Migration 0006 built the outbox around one `published_at` flag on the
-- explicit reasoning "one relay drains one queue". That reasoning was
-- correct when it was written and stops being correct the moment a second
-- consumer exists: `published_at` is a single global "done" marker, so
-- whichever consumer sets it first makes the row disappear from every
-- consumer's scan after it — including ones that have not seen it yet.
-- Phase 4's realtime broadcaster is that second consumer. 0006's own comment
-- on the relay's grants already named the fix ("it gets its own role and its
-- own pair of policies") without building the table that makes it possible.
-- This migration is that table.
--
-- outbox_dispatch replaces the single flag with one row per (event,
-- consumer). A consumer's claim becomes "not yet dispatched TO ME" instead
-- of "not yet dispatched to anyone", so audit finishing first no longer
-- erases the event for realtime, search, or anything dispatched after it.
--
-- Deliberately an EXISTENCE scan (dispatched_at IS NULL), not a position
-- cursor, for the same reason 0006 scanned "published_at IS NULL" instead of
-- keeping a high-water mark: a cursor recording "processed through position
-- N" silently skips a transaction that commits late with an occurred_at
-- earlier than N. Generalizing that to a cursor per consumer would
-- reintroduce the bug once per consumer instead of once for the whole table.

CREATE TABLE platform.outbox_dispatch (
  event_id      uuid        NOT NULL REFERENCES platform.outbox (id) ON DELETE CASCADE,
  -- A short, stable name ('audit', 'realtime') — never user input, and
  -- checked against exactly that assumption below by RLS.
  consumer      text        NOT NULL,

  -- Null until THIS consumer has dispatched the event. Not a deletion —
  -- same "history stays" reasoning 0006 gave for published_at.
  dispatched_at timestamptz,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,

  PRIMARY KEY (event_id, consumer),
  CONSTRAINT outbox_dispatch_consumer_present CHECK (length(btrim(consumer)) > 0)
);

-- Every consumer's claim query, proportional to ITS OWN backlog rather than
-- the union of every consumer's — the same reason 0006's index is partial.
CREATE INDEX outbox_dispatch_pending_idx
  ON platform.outbox_dispatch (consumer, event_id)
  WHERE dispatched_at IS NULL;

-- Backfill. Every event already carrying published_at under the old
-- single-reader model was, in fact, dispatched — to audit, the only
-- consumer that has ever existed. Recorded under that name rather than left
-- for audit to reprocess: without this, every already-published event in a
-- running deployment would be redelivered into the audit log a second time
-- the moment this migration lands, which corrupts the hash chain's meaning
-- exactly as duplicate delivery does anywhere else in this table's design.
--
-- platform.outbox is FORCE ROW LEVEL SECURITY (migration 0006), which — per
-- 0008's note on the same point — applies row security to the table OWNER
-- too. taskflow_migrator owns it and is NOBYPASSRLS, and no policy on
-- platform.outbox grants it cross-tenant SELECT: outbox_tenant_isolation is
-- scoped by app.org_id (unset during a migration) and outbox_relay_read is
-- scoped TO taskflow_audit specifically. Left as FORCE, the SELECT below
-- would silently match zero rows against a database that genuinely has
-- published events — not an error, just quietly wrong, which is worse.
-- Lifted for this one statement and restored immediately after; nothing
-- about platform.outbox's security posture outside this transaction changes.
ALTER TABLE platform.outbox NO FORCE ROW LEVEL SECURITY;

INSERT INTO platform.outbox_dispatch (event_id, consumer, dispatched_at, attempts)
SELECT id, 'audit', published_at, attempts
  FROM platform.outbox
 WHERE published_at IS NOT NULL;

ALTER TABLE platform.outbox FORCE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
--
-- Not tenant-scoped, matching platform.outbox itself: dispatch bookkeeping
-- belongs to a CONSUMER, not an org, so no value of app.org_id is right here
-- either. What replaces it is the `consumer` column, checked the same way
-- org_id is checked everywhere else in this system — a policy scoped to one
-- role, with a WITH CHECK naming the one consumer value that role may ever
-- write. A bug in the audit projection that tried to write a REALTIME
-- dispatch row is refused at the database, not merely by code review.
-- --------------------------------------------------------------------------
ALTER TABLE platform.outbox_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_dispatch FORCE  ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON platform.outbox_dispatch TO taskflow_audit;

-- Three separate policies, one per command, matching 0006's
-- outbox_relay_read / outbox_relay_mark split rather than one FOR ALL — the
-- point of naming them apart is that "what may taskflow_audit SELECT vs.
-- INSERT vs. UPDATE" stays three separately auditable answers instead of
-- one combined one a future edit could widen without noticing which command
-- it affected.
DROP POLICY IF EXISTS outbox_dispatch_audit_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_audit_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_audit
  USING (consumer = 'audit');

DROP POLICY IF EXISTS outbox_dispatch_audit_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_audit_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_audit
  WITH CHECK (consumer = 'audit');

DROP POLICY IF EXISTS outbox_dispatch_audit_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_audit_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_audit
  USING (consumer = 'audit')
  WITH CHECK (consumer = 'audit');

-- --------------------------------------------------------------------------
-- What this migration deliberately does NOT do.
--
-- It does not add a `taskflow_realtime` role or policies for it. That role
-- belongs with `apps/realtime` itself — creating it now, with nothing yet
-- connecting as it, would be an unused credential sitting in the database
-- for however long it takes to build the app that uses it. Adding a
-- consumer from here on is: grant that role SELECT/INSERT/UPDATE on
-- platform.outbox_dispatch and its own three policies scoped to its own
-- consumer name, mirroring the outbox_dispatch_audit_* policies above. No
-- further schema change.
--
-- It does not touch platform.outbox's own grants or its
-- outbox_relay_mark policy (migration 0006). taskflow_audit keeps UPDATE on
-- platform.outbox for now — unused after this migration, since
-- packages/db/src/outbox.ts no longer writes published_at — and is
-- tightened in the later migration that drops the deprecated columns
-- (expand-migrate-contract, PLAN.md §7.4), rather than churning the grant
-- twice.
-- --------------------------------------------------------------------------
