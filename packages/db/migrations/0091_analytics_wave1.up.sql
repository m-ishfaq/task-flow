-- 0091 — the analytics transitions projection and its claim role
-- (Phase 11 Wave 1, ai/phase-11-analytics.md §1-§2).
--
-- Every analytics metric is a question about the PAST, and the transactional
-- schema only stores the PRESENT: a card row knows it is in Done, not WHEN it
-- got there, how long it sat in Active first, or whether it went back. So this
-- phase's spine is a transitions projection fed by the outbox — the fifth
-- consumer on the pattern search.documents (0045) established, mirrored here
-- almost line for line.
--
-- ==========================================================================
-- A NEW SCHEMA, AND DELIBERATELY NO `ALTER DEFAULT PRIVILEGES` ON IT
-- ==========================================================================
--
-- The same decision 0045 (search) and 0041 (rtc) made: 0001 pairs every schema
-- it creates with ALTER DEFAULT PRIVILEGES giving taskflow_app full CRUD on
-- every table a later migration adds there, which makes a "SELECT/INSERT only"
-- grant weaker than what the database already enforces (0036's lesson). With no
-- default privileges here, every grant is explicit forever — which is what makes
-- "nothing may UPDATE or DELETE a transition" a fact rather than an intention,
-- the append-only immutability the audit log gets the same way.

CREATE SCHEMA IF NOT EXISTS analytics;

GRANT USAGE ON SCHEMA analytics TO taskflow_app;

-- --------------------------------------------------------------------------
-- analytics.card_transitions — the fact table.
--
-- One row per status change: the card, its board and project, the from- and
-- to-status resolved to their CATEGORY, and when. Small by construction — one
-- row per transition, never one per card per day (§1).
--
-- ## Category is frozen at transition time, and that is not an optimization
--
-- A project can rename or re-categorize a status later. If a rollup resolved
-- category by joining work.statuses at query time, re-categorizing one status
-- would silently rewrite last quarter's velocity. Storing what the category WAS
-- makes history immutable, which is what history means — the same argument
-- comms.calls.consent_basis makes for recording why a decision was taken rather
-- than re-deriving it later.
--
-- ## No foreign key to work.cards / boards / projects, deliberately
--
-- Exactly like search.documents' bare entity_id: the projection is decoupled
-- from the source rows, and a card deleted later must NOT take its history with
-- it (§7 decision 6 — keep forever). Only org_id is a real FK, with CASCADE, so
-- deleting an org cleans up its analytics and nothing else has to.
--
-- ## `from_category` NULL means creation-from-nothing
--
-- A card's very first appearance is a transition from no status into its
-- initial one. §2.2's synthetic backfill row for a card that existed before this
-- projection uses exactly that shape: from_category NULL, synthetic true.
--
-- ## Idempotency under the at-least-once claim contract
--
-- A redelivered card.status_changed carries the same source event id, so
-- source_event_id is the upsert key for real rows (partial unique below). A
-- synthetic creation row has no event; its idempotency is the (org_id, card_id)
-- partial unique instead, so the §2.2 backfill is safe to re-run.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.card_transitions (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  card_id         uuid        NOT NULL,
  board_id        uuid        NOT NULL,
  project_id      uuid        NOT NULL,

  -- The status category (0011's work.statuses.category) at the moment of the
  -- transition. NULL `from` = the card's creation, a move from nothing into
  -- its first status.
  from_category   text,
  to_category     text        NOT NULL,

  occurred_at     timestamptz NOT NULL,

  -- true when this row was SYNTHESIZED (a card's creation transition, real or
  -- backfilled) rather than read from a real card.status_changed event (§2.2).
  synthetic       boolean     NOT NULL DEFAULT false,

  -- The source outbox event id, for idempotency (see the header). NULL for a
  -- synthetic creation row, which has no event to key on.
  source_event_id uuid,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT card_transitions_from_category_valid
    CHECK (from_category IS NULL OR from_category IN ('not_started', 'active', 'done')),
  CONSTRAINT card_transitions_to_category_valid
    CHECK (to_category IN ('not_started', 'active', 'done')),

  -- "Representable states are valid states" (0010/0083's discipline): a
  -- synthetic row is a creation (from nothing) carrying no event; a real row
  -- carries its event id. The two shapes are the only two the projection ever
  -- writes.
  CONSTRAINT card_transitions_source_shape
    CHECK (
      (synthetic AND source_event_id IS NULL AND from_category IS NULL) OR
      (NOT synthetic AND source_event_id IS NOT NULL)
    )
);

-- One fact row per real event: a redelivered card.status_changed inserts
-- nothing (ON CONFLICT DO NOTHING against this). Partial, because synthetic
-- rows carry no event id.
CREATE UNIQUE INDEX card_transitions_event_key
  ON analytics.card_transitions (org_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- One synthetic creation row per card, so §2.2's backfill is safe to re-run.
CREATE UNIQUE INDEX card_transitions_synthetic_card_key
  ON analytics.card_transitions (org_id, card_id)
  WHERE synthetic;

-- The daily rollups (Wave 2) walk a board's transitions in time order —
-- velocity, CFD and the like are per board over a window. org_id leads because
-- every query is RLS-scoped to one org.
CREATE INDEX card_transitions_board_idx
  ON analytics.card_transitions (org_id, board_id, occurred_at);

-- Cycle time follows a single card's own transitions (first active -> first done).
CREATE INDEX card_transitions_card_idx
  ON analytics.card_transitions (org_id, card_id, occurred_at);

-- --------------------------------------------------------------------------
-- Row-Level Security (§5) — the generated form, repeated verbatim from
-- packages/db/src/rls.ts as 0045 does. FORCE applies it to the table owner
-- (taskflow_migrator) too; NULLIF collapses an unset and an empty app.org_id to
-- the same NULL so a scoping bug fails closed rather than raising 22P02.
--
-- The app role is the only reader AND writer: the projection writes each fact
-- row under withOrgScope as taskflow_app (the 0035 "one role, one job" shape),
-- and the Wave 2 rollup refresh reads the same way, so one policy pair serves
-- both.
-- --------------------------------------------------------------------------
ALTER TABLE analytics.card_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.card_transitions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_transitions_tenant_isolation ON analytics.card_transitions;
CREATE POLICY card_transitions_tenant_isolation ON analytics.card_transitions
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Append-only by GRANT: SELECT and INSERT, never UPDATE or DELETE. A transition
-- is a historical fact; nothing in the application may rewrite one, the same
-- immutability taskflow_audit's grants give the audit log. Org deletion still
-- reaches these rows through the org_id FK's CASCADE, which is not subject to
-- this grant.
GRANT SELECT, INSERT ON analytics.card_transitions TO taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_analytics — the projection's CLAIM role (0016/0045's recipe).
--
-- The role is created in docker/postgres/init/02-roles.sql, not here — roles
-- are cluster-wide and the migrator is NOCREATEROLE. A database whose volume
-- predates that file fails this migration with "role taskflow_analytics does
-- not exist"; the fix is `docker compose down -v && docker compose up -d`.
--
-- What it may do is deliberately tiny: CLAIM card.status_changed events from
-- the outbox under its own consumer name. It holds NOTHING on
-- analytics.card_transitions — the fact write happens afterward, per event,
-- under taskflow_app inside withOrgScope, exactly as taskflow_search claims and
-- then indexes as taskflow_app (0045's header).
--
-- The consumer name 'analytics' needs no CHECK widening: outbox_dispatch's only
-- CHECK (0015) is `length(btrim(consumer)) > 0`, so it is legal the moment a
-- policy names it.
-- --------------------------------------------------------------------------
GRANT USAGE ON SCHEMA platform TO taskflow_analytics;

-- Reading the queue. Its own three policies scoped to its own role, mirroring
-- outbox_search_read (0045) rather than widening it — separately revocable.
GRANT SELECT, UPDATE ON platform.outbox TO taskflow_analytics;

DROP POLICY IF EXISTS outbox_analytics_read ON platform.outbox;
CREATE POLICY outbox_analytics_read ON platform.outbox
  FOR SELECT TO taskflow_analytics
  USING (true);

-- WITH CHECK (false), not (true), and the asymmetry is the whole point — the
-- identical reasoning 0016/0045 document: claimPending claims with
-- `SELECT ... FOR UPDATE OF o SKIP LOCKED`, and Postgres's RLS for a LOCKING
-- select requires a row to pass a policy applying to UPDATE. Without this the
-- claim silently returns zero rows, indistinguishable from an idle queue. WITH
-- CHECK (false) permits the lock (a locking select never writes a row, so it
-- never reaches WITH CHECK) and refuses an actual write, because this role's
-- bookkeeping lives in outbox_dispatch, never on the outbox row itself.
DROP POLICY IF EXISTS outbox_analytics_mark ON platform.outbox;
CREATE POLICY outbox_analytics_mark ON platform.outbox
  FOR UPDATE TO taskflow_analytics
  USING (true)
  WITH CHECK (false);

-- Its own dispatch bookkeeping, pinned to its own consumer name. The WITH CHECK
-- keeps one consumer's typo from erasing another's queue.
GRANT SELECT, INSERT, UPDATE ON platform.outbox_dispatch TO taskflow_analytics;

DROP POLICY IF EXISTS outbox_dispatch_analytics_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_analytics_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_analytics
  USING (consumer = 'analytics');

DROP POLICY IF EXISTS outbox_dispatch_analytics_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_analytics_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_analytics
  WITH CHECK (consumer = 'analytics');

DROP POLICY IF EXISTS outbox_dispatch_analytics_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_analytics_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_analytics
  USING (consumer = 'analytics')
  WITH CHECK (consumer = 'analytics');
