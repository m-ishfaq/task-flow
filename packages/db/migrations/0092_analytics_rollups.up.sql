-- 0092 — analytics rollups (Phase 11, ai/phase-11-analytics.md §1, §6).
--
-- Pre-computed aggregations over analytics.card_transitions, refreshed on a
-- schedule by a worker loop. Dashboards read these instead of computing
-- on-the-fly from the fact table — the property §7.3 prescribes:
-- "Materialized views refreshed on a schedule, never live aggregation over
-- transactional tables."
--
-- These are REGULAR TABLES, not materialized views, because:
-- 1. Materialized views cannot have RLS. A global view would need either
--    per-org dynamic views (complex) or app-level org filtering (unsafe).
-- 2. Regular tables with RLS give the same pre-computed read performance
--    with native tenant isolation — the same pattern every other table
--    in this codebase uses.
-- 3. The refresh service upserts per-org, so only active orgs are refreshed
--    (§6: "Refresh respects identity.orgs.status").
--
-- The trade: a refresh is an upsert, not an atomic swap like CONCURRENTLY.
-- But the upserts are per-org and per-day, so the window of inconsistency
-- is one row, not the whole table — and the staleness display (§6) tells
-- the user when data was last computed.

-- --------------------------------------------------------------------------
-- analytics.rollup_velocity — daily done counts per board (§3.1)
--
-- One row per (org, board, date). The refresh computes:
--   COUNT(*) of card_transitions where to_category = 'done' for that day.
-- Dashboard queries filter by org_id (RLS) and optionally board_id.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.rollup_velocity (
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  board_id    uuid        NOT NULL,
  day         date        NOT NULL,
  done_count  integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, board_id, day)
);

-- --------------------------------------------------------------------------
-- analytics.rollup_cfd — daily category counts per board (§3.3)
--
-- One row per (org, board, date, category). The refresh walks transitions
-- forward from a snapshot to compute cumulative counts.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.rollup_cfd (
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  board_id    uuid        NOT NULL,
  day         date        NOT NULL,
  category    text        NOT NULL,
  card_count  integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, board_id, day, category),
  CONSTRAINT rollup_cfd_category_valid
    CHECK (category IN ('not_started', 'active', 'done'))
);

-- --------------------------------------------------------------------------
-- analytics.rollup_cycle_time — per-card cycle time (§3.4)
--
-- One row per (org, card_id). Computed once per card: the hours from first
-- active to first done. NULL cycle_time_hours means the card never reached
-- done (open card).
-- --------------------------------------------------------------------------
CREATE TABLE analytics.rollup_cycle_time (
  org_id              uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  card_id             uuid        NOT NULL,
  board_id            uuid        NOT NULL,
  project_id          uuid        NOT NULL,
  cycle_time_hours    double precision,
  first_active_at     timestamptz,
  first_done_at       timestamptz,

  PRIMARY KEY (org_id, card_id)
);

-- --------------------------------------------------------------------------
-- analytics.rollup_volume — daily message/call counts (§3.6)
--
-- One row per (org, day). The refresh queries chat.messages, comms.calls,
-- and rtc.sessions directly — these are present-state counts, not historical
-- transitions.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.rollup_volume (
  org_id              uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  day                 date        NOT NULL,
  message_count       integer     NOT NULL DEFAULT 0,
  call_count          integer     NOT NULL DEFAULT 0,
  call_duration_min   double precision NOT NULL DEFAULT 0,
  in_app_call_count   integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, day)
);

-- --------------------------------------------------------------------------
-- Row-Level Security — the same tenant_isolation pattern 0091 uses.
-- --------------------------------------------------------------------------

ALTER TABLE analytics.rollup_velocity ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_velocity FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rollup_velocity_tenant_isolation ON analytics.rollup_velocity;
CREATE POLICY rollup_velocity_tenant_isolation ON analytics.rollup_velocity
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE analytics.rollup_cfd ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_cfd FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rollup_cfd_tenant_isolation ON analytics.rollup_cfd;
CREATE POLICY rollup_cfd_tenant_isolation ON analytics.rollup_cfd
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE analytics.rollup_cycle_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_cycle_time FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rollup_cycle_time_tenant_isolation ON analytics.rollup_cycle_time;
CREATE POLICY rollup_cycle_time_tenant_isolation ON analytics.rollup_cycle_time
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE analytics.rollup_volume ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_volume FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rollup_volume_tenant_isolation ON analytics.rollup_volume;
CREATE POLICY rollup_volume_tenant_isolation ON analytics.rollup_volume
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants — SELECT and INSERT/UPDATE for the app role (refresh writes,
-- dashboards read). No DELETE — a rollup row is a historical fact.
-- --------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON analytics.rollup_velocity TO taskflow_app;
GRANT SELECT, INSERT, UPDATE ON analytics.rollup_cfd TO taskflow_app;
GRANT SELECT, INSERT, UPDATE ON analytics.rollup_cycle_time TO taskflow_app;
GRANT SELECT, INSERT, UPDATE ON analytics.rollup_volume TO taskflow_app;

-- The refresh service also needs to DELETE old rollup rows when recomputing
-- (e.g., a board's CFD is recomputed from scratch for a date range).
-- Scoped to the app role, protected by RLS.
GRANT DELETE ON analytics.rollup_velocity TO taskflow_app;
GRANT DELETE ON analytics.rollup_cfd TO taskflow_app;
GRANT DELETE ON analytics.rollup_cycle_time TO taskflow_app;
GRANT DELETE ON analytics.rollup_volume TO taskflow_app;
