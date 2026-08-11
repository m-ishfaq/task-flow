-- 0054 — sprints (ai/phase-10.5-sprints.md, Phase 10.5, Slice 1)
--
-- The sprint record: a project's planning unit, built so Phase 11's burndown
-- has a real per-sprint concept to compute over instead of an arbitrary date
-- range. Three things here are load-bearing, and each mirrors a decision the
-- spec resolves rather than a column count.
--
-- 1. A SPRINT BELONGS TO A PROJECT, LIKE A STATUS — NOT TO A BOARD.
--    Statuses, labels and custom fields are already project-scoped vocabulary
--    (0011's header says why: per board would multiply what a user maintains
--    by the number of boards). The sprint is the same kind of thing. And
--    `cards.sprint_id` is constrained the same way `cards.status_id` is:
--    a COMPOSITE foreign key (org_id, project_id, sprint_id) against the
--    sprints' (org_id, project_id, id) — so a card can never name a sprint
--    from another project. That is the 0008 hierarchy lesson applied to the
--    new column: `withOrgScope` stops cross-tenant writes and does nothing
--    about a same-tenant wrong-project write, and Drizzle's `references()`
--    is single-column and cannot express the composite, so the migration
--    is the source of truth (see schema/work.ts's file header).
--
-- 2. AT MOST ONE ACTIVE SPRINT PER PROJECT, ENFORCED BY THE DATABASE.
--    The partial unique index below is what makes "the active sprint" a
--    well-formed question — the picker, the board filter, and Phase 11's
--    burndown all need the answer to have at most one value. Multiple
--    `planned` sprints are fine (that is how teams line work up); two
--    running ones is a team that has stopped using the tool. The service
--    checks first and the index is the backstop, so the invariant holds
--    even if a caller goes around the service.
--
-- 3. THE BACKLOG IS NOT A ROW — `cards.sprint_id IS NULL` IS THE BACKLOG.
--    There is no `backlog` sprint to create, delete, or fight over. The
--    pool of unassigned work is the complement of membership, and the
--    closure semantics (done cards stay attached, unfinished cards return
--    to the backlog) are a transaction, not a merge.
--
-- `status` is a text column with a CHECK on the four lifecycle values;
-- the SERVICE owns the transitions (planned -> active -> completed, plus
-- cancelled from either) — the column keeps corruption out, not the
-- application's logic in.
--
-- `starts_on`/`ends_on` are DATE, not timestamptz: a sprint is a span of
-- days, not an instant. `completed_at` is the ACTUAL end, written by the
-- completion transition — Phase 11 uses it over `ends_on` when present,
-- because the planned date is the curve's target and the actual date is
-- the truth.

CREATE TABLE work.sprints (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  project_id   uuid        NOT NULL,

  name         text        NOT NULL,
  -- Most sprints have a goal; none are required to. Nullable, like
  -- `projects.description` — a goal is prose, not a constraint.
  goal         text,

  starts_on    date        NOT NULL,
  ends_on      date        NOT NULL,

  -- planned | active | completed | cancelled. See note 3 in the header:
  -- the service owns the transitions, this CHECK keeps corruption out.
  status       text        NOT NULL DEFAULT 'planned',

  -- Written by the START and COMPLETE transitions, never inferred from the
  -- dates — see the header's `completed_at` note.
  started_at   timestamptz,
  completed_at timestamptz,

  created_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sprints_name_present  CHECK (length(btrim(name)) > 0),
  CONSTRAINT sprints_name_length   CHECK (length(name) <= 120),
  CONSTRAINT sprints_status_valid  CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  CONSTRAINT sprints_dates_ordered CHECK (ends_on >= starts_on),

  CONSTRAINT sprints_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id)
);

-- One active sprint per project (note 2 in the header).
CREATE UNIQUE INDEX sprints_one_active_per_project
  ON work.sprints (project_id) WHERE status = 'active';

-- The (org_id, project_id, id) unique key the card-side composite FK below
-- references — Postgres requires the referenced columns to be unique, and
-- this is the same shape statuses uses so `cards.sprint_id` can assert
-- sprint-within-project in one constraint.
CREATE UNIQUE INDEX sprints_org_project_id_key
  ON work.sprints (org_id, project_id, id);

-- The card side. Expand-only: nullable, and stays nullable — the backlog is a
-- legitimate state (note 3), not a backfill waiting to happen. The composite
-- FK is what makes a card's sprint provably its own project's.
ALTER TABLE work.cards ADD COLUMN sprint_id uuid;
ALTER TABLE work.cards ADD CONSTRAINT cards_sprint_fk
  FOREIGN KEY (org_id, project_id, sprint_id)
  REFERENCES work.sprints (org_id, project_id, id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, verbatim from rls.ts.
-- --------------------------------------------------------------------------

ALTER TABLE work.sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.sprints FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sprints_tenant_isolation ON work.sprints;
CREATE POLICY sprints_tenant_isolation ON work.sprints
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants — the 0036 lesson applied to a work table.
-- --------------------------------------------------------------------------
-- The `work` schema carries ALTER DEFAULT PRIVILEGES from 0001, so
-- taskflow_app held full CRUD on `sprints` before this file's GRANT section
-- ran — the same situation 0036 diagnosed for `platform`. What this table
-- must NOT have is DELETE: a sprint's terminal states are `completed` and
-- `cancelled` — the record Phase 11's burndown reads is exactly the set of
-- completed sprints, and a hard delete would erase history nothing asked to
-- erase. There is no delete route in the phase, and the REVOKE makes that a
-- fact rather than a convention.
REVOKE DELETE ON work.sprints FROM taskflow_app;
