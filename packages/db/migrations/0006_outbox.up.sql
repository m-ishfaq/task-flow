-- 0006 — the transactional outbox (PLAN.md §10.6, §2.1 guardrail 11)
--
-- The seam between a mutation and everything reactive: audit, notifications,
-- realtime broadcast, search indexing, and automation. All five read this one
-- stream rather than being called individually by each service method.
--
-- WHY A TABLE RATHER THAN A PUBLISH CALL.
-- Publishing after the commit loses the event forever if the process dies in
-- between. Publishing before it emits an event for something that never
-- happened, if the transaction then rolls back. Neither is recoverable and both
-- are invisible until an audit. Writing the event INSIDE the mutation's own
-- transaction makes the mutation and its event atomic; a relay moves rows out
-- afterwards, at-least-once, which is why consumers must be idempotent.
--
-- ONE READER, NOT FIVE. The relay is the single consumer of this table and
-- fans out downstream (pg-boss, §4.2). That is what makes a single
-- `published_at` correct rather than a per-consumer cursor: five readers
-- sharing one high-water mark would each skip events the others had marked, and
-- a bigserial cursor would additionally skip any transaction that committed out
-- of sequence order.

CREATE TABLE platform.outbox (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- Mirrors the envelope in @taskflow/events. Stored as columns rather than one
  -- jsonb blob because the relay filters and orders on them, and because a
  -- consumer reading `name` should not depend on the payload parsing first.
  name         text        NOT NULL,
  version      integer     NOT NULL,
  actor_id     uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL,
  request_id   text,
  payload      jsonb       NOT NULL,

  -- Null until the relay has dispatched it. NOT a deletion: keeping dispatched
  -- rows for a retention window is what makes "did this event ever fire?"
  -- answerable during an incident.
  published_at timestamptz,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT outbox_version_positive CHECK (version > 0)
);

-- The relay's only query. Partial, so it stays proportional to the BACKLOG
-- rather than to the history — the index does not grow as dispatched rows
-- accumulate, which is the difference between a relay that keeps working after
-- a year and one that slows down every day.
CREATE INDEX outbox_pending_idx
  ON platform.outbox (occurred_at, id)
  WHERE published_at IS NULL;

-- "What happened in this org?" — the admin event browser, and the retention job.
CREATE INDEX outbox_org_idx ON platform.outbox (org_id, occurred_at DESC);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
-- --------------------------------------------------------------------------
ALTER TABLE platform.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_tenant_isolation ON platform.outbox;
CREATE POLICY outbox_tenant_isolation ON platform.outbox
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- The relay's access.
--
-- The relay reads across every org by definition — it drains one queue, not one
-- tenant's queue — so no value of `app.org_id` is right for it. The escape is a
-- policy scoped `TO` a named role rather than BYPASSRLS on the role itself:
-- BYPASSRLS would unfilter that role against every table in the database,
-- forever, whereas this widens exactly one table and is visible in
-- \d platform.outbox.
--
-- taskflow_audit carries it because in this phase the relay and the audit
-- projection are one process, and one transaction that marks a row published
-- and writes its audit entry is exactly-once rather than at-least-once. When
-- the second consumer arrives (Phase 4), it gets its own role and its own pair
-- of policies here — not a widening of these.
--
-- Note what is NOT granted: DELETE. The relay marks rows published; pruning
-- them is a retention job running as the migrator.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform TO taskflow_audit;
GRANT SELECT, UPDATE ON platform.outbox TO taskflow_audit;

DROP POLICY IF EXISTS outbox_relay_read ON platform.outbox;
CREATE POLICY outbox_relay_read ON platform.outbox
  FOR SELECT TO taskflow_audit
  USING (true);

DROP POLICY IF EXISTS outbox_relay_mark ON platform.outbox;
CREATE POLICY outbox_relay_mark ON platform.outbox
  FOR UPDATE TO taskflow_audit
  USING (true)
  WITH CHECK (true);
