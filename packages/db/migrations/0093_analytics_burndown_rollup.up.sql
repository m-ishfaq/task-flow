-- 0093 — burndown rollup (Phase 11, ai/phase-11-analytics.md §3.2).
--
-- Pre-computed daily done/undone card counts per project, used by the
-- burndown dashboard in date-range mode. Sprint mode still reads
-- card_transitions directly because sprint membership is dynamic.
--
-- One row per (org, project, day). The refresh service walks
-- card_transitions and computes net done/undone per day:
--   done_count   = distinct cards entering 'done' category
--   undone_count = distinct cards leaving 'done' category
--
-- Dashboard computes remaining as:
--   total_cards_at_start - cumulative_done + cumulative_undone
--
-- RLS follows the same tenant_isolation pattern as 0091/0092.

CREATE TABLE analytics.rollup_burndown (
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  project_id    uuid        NOT NULL,
  day           date        NOT NULL,
  done_count    integer     NOT NULL DEFAULT 0,
  undone_count  integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, project_id, day)
);

ALTER TABLE analytics.rollup_burndown ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_burndown FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rollup_burndown_tenant_isolation ON analytics.rollup_burndown;
CREATE POLICY rollup_burndown_tenant_isolation ON analytics.rollup_burndown
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.rollup_burndown TO taskflow_app;
