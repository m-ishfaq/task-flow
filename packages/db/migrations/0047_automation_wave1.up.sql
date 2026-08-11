-- 0047 — the automation rules engine (ai/phase-10-automation.md, Wave 1)
--
-- PLAN.md §10.3: cross-product rules, trigger -> conditions -> actions, run as
-- a consumer of the domain event bus rather than as a subsystem with triggers
-- of its own. §365 has listed `automations` and `automation_runs` in the
-- `platform` schema since the plan was written; they arrive here.
--
-- ==========================================================================
-- WHY THESE TABLES LIVE IN `platform` AND WHAT THAT COSTS
-- ==========================================================================
--
-- `platform` is one of the schemas 0001 paired with ALTER DEFAULT PRIVILEGES,
-- which is exactly the trap migration 0036 had to correct and 0041/0045 avoided
-- by creating schemas without them: taskflow_app already holds full CRUD on
-- every table the migrator creates here, BEFORE any GRANT in this file runs.
--
-- A new `automation` schema was considered and rejected. These tables are
-- ordinary org-scoped application data — a rule is written by an admin through
-- a route and read by the engine under `withOrgScope`, exactly like a saved
-- view — so taskflow_app's full CRUD is what they should have anyway, and the
-- default privileges grant it correctly rather than accidentally. What matters
-- is that this is stated: the grants below are a restatement of access that
-- already exists, not the thing creating it. The role that must NOT reach these
-- tables is taskflow_automation, and the way that is guaranteed is by never
-- granting it anything here — see the bottom of this file.

-- --------------------------------------------------------------------------
-- platform.automations — the rules.
--
-- `trigger_event` is a domain event NAME (`card.status_changed`), validated at
-- the route against the live registry rather than by a CHECK here. A CHECK
-- would be a second copy of the event catalog that drifts every time a slice
-- adds an event, and the failure mode of the drift is a rule that can be saved
-- and never fires — silent, and indistinguishable from a condition that never
-- matches.
--
-- `condition` is a FilterNode tree, or NULL for "fire on every occurrence".
-- Stored UNRESOLVED exactly as `work.views.filter` and `search.searches.query`
-- are, and re-validated on read: a column is not a parser. `@me` is REFUSED at
-- write time rather than stored — a rule has no viewer, so `@me` would either
-- throw at execution or silently resolve to whoever saved the rule, which is
-- the trap 0014's header documents for shared views, in a context with no user
-- at all to fall back on.
--
-- `actions` is a jsonb ARRAY of typed action objects, each naming a service
-- method and its arguments, validated by Zod at write and re-validated at
-- execution. Never a script, never a template string that becomes code.
-- --------------------------------------------------------------------------
CREATE TABLE platform.automations (
  id             uuid        PRIMARY KEY,
  org_id         uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name           text        NOT NULL,
  description    text,

  trigger_event  text        NOT NULL,
  condition      jsonb,
  actions        jsonb       NOT NULL,

  -- The per-rule half of the kill switch (§4, layer 4). The org-wide half is
  -- `identity.orgs.status`, which the engine already honours for free.
  enabled        boolean     NOT NULL DEFAULT true,

  -- WHOSE PERMISSIONS THE ACTIONS RUN WITH (§2), re-resolved at EXECUTION and
  -- never trusted from save time. ON DELETE CASCADE, and that is the control
  -- rather than housekeeping: a rule whose owner has left the organization
  -- must stop acting with privileges nobody holds any more. A stored rule is
  -- otherwise a credential that never expires.
  created_by     uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automations_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT automations_name_length  CHECK (length(name) <= 120),

  CONSTRAINT automations_trigger_present CHECK (length(btrim(trigger_event)) > 0),

  -- Shape only; MEANING is the service's job. Catches an array or a bare
  -- string reaching the column, which would fail to parse on every read.
  CONSTRAINT automations_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),

  -- A rule with no actions is a rule that does nothing, and a rule with fifty
  -- is a rule nobody can reason about — including the person debugging why
  -- action 37 failed. The ceiling also bounds the per-run work the engine can
  -- be asked to do from a single event.
  CONSTRAINT automations_actions_shape
    CHECK (jsonb_typeof(actions) = 'array'
           AND jsonb_array_length(actions) BETWEEN 1 AND 10)
);

-- The engine's hot path: "every enabled rule in this org for this event".
-- Leads with org_id per the RLS convention; `enabled` is in the index rather
-- than a partial predicate so a disabled rule's row is still reachable by the
-- management UI through the same index.
CREATE INDEX automations_trigger_idx
  ON platform.automations (org_id, trigger_event, enabled);

-- One rule name per org, case-insensitive. Two rules called "Notify on done"
-- are indistinguishable in a run-history list, which is where a name is
-- actually read.
CREATE UNIQUE INDEX automations_org_name_key
  ON platform.automations (org_id, lower(name));

-- What `automation_runs`' composite FK references, and it has to exist BEFORE
-- that table is created — Postgres resolves a REFERENCES clause at CREATE
-- TABLE time and refuses with "there is no unique constraint matching given
-- keys for referenced table". Declared here rather than beside the runs table
-- for that reason alone.
CREATE UNIQUE INDEX automations_org_id_key ON platform.automations (org_id, id);

-- --------------------------------------------------------------------------
-- platform.automation_runs — what happened, every time (§3).
--
-- Written even when the condition did NOT match (`skipped`). "My rule did not
-- fire" is the single most common question a rules engine is asked, and a
-- history that records only successes cannot answer it — the asker cannot even
-- tell whether the engine saw the event.
--
-- This is a PROJECTION, not a ledger: the actions themselves are already in
-- `audit.audit_log`, written by the service layer the engine calls, under the
-- hash chain. These rows are operational telemetry, so they are prunable on a
-- retention window in a way an audit entry never is.
-- --------------------------------------------------------------------------
CREATE TABLE platform.automation_runs (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  automation_id uuid        NOT NULL,

  -- The event that triggered this run. NOT a foreign key to platform.outbox,
  -- deliberately: Phase 11 will prune that table on a retention window
  -- (ai/phase-11-analytics.md §7 decision 7), and an FK would either block the
  -- prune or cascade away the run history it has no business deleting.
  event_id      uuid        NOT NULL,
  trigger_event text        NOT NULL,

  status        text        NOT NULL,

  -- Why a run did not proceed: 'condition_not_met', 'rule_disabled',
  -- 'org_suspended', 'depth_exceeded', 'budget_exhausted', 'unauthorized'.
  -- Free text rather than a CHECK — the set will grow with the action
  -- catalogue, and a refusal reason that cannot be recorded because the
  -- constraint predates it is a refusal that gets logged as something else.
  reason        text,

  -- Per-ACTION outcomes, in order: [{ index, type, status, error? }]. §9
  -- decision 6 — a run stops at the first failing action and records WHICH,
  -- so a partially-applied rule is diagnosable rather than mysterious.
  action_results jsonb      NOT NULL DEFAULT '[]'::jsonb,

  -- Loop-protection depth (§4, layer 1) as it was AT THIS RUN. Recorded
  -- because "why did my chain stop at five" needs an answer that does not
  -- require reconstructing the chain.
  depth         integer     NOT NULL DEFAULT 0,

  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT automation_runs_status_valid
    CHECK (status IN ('succeeded', 'failed', 'refused', 'skipped')),

  CONSTRAINT automation_runs_depth_nonnegative CHECK (depth >= 0),

  CONSTRAINT automation_runs_action_results_shape
    CHECK (jsonb_typeof(action_results) = 'array'),

  -- org-scoped composite FK, the work.cards pattern: a run can never name a
  -- rule belonging to another tenant, and the database refuses it rather than
  -- the service remembering to check.
  CONSTRAINT automation_runs_automation_fk
    FOREIGN KEY (org_id, automation_id)
      REFERENCES platform.automations (org_id, id) ON DELETE CASCADE
);

-- The run-history UI: newest first, per rule or across the org.
CREATE INDEX automation_runs_recent_idx
  ON platform.automation_runs (org_id, created_at DESC);
CREATE INDEX automation_runs_rule_idx
  ON platform.automation_runs (org_id, automation_id, created_at DESC);

-- --------------------------------------------------------------------------
-- platform.automation_budget — the DURABLE per-org hourly execution budget
-- (§4, layer 3).
--
-- In Postgres, not in process, and that is the whole point. An in-process
-- counter forgives everyone on restart, which is the state an attacker
-- restarts you to reach — the identical argument Phase 13's TURN issuance
-- budget makes, and the identical mistake the telephony velocity limiter is
-- allowed to make ONLY because a durable spend ledger sits behind it. Here
-- there is nothing behind it, so it has to be durable itself.
--
-- One row per (org, hour). The hour is a truncated timestamptz rather than a
-- rolling window because a fixed bucket can be incremented with a single
-- upsert under concurrency, where a rolling window needs a count-then-write
-- that two workers both pass.
-- --------------------------------------------------------------------------
CREATE TABLE platform.automation_budget (
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  window_hour timestamptz NOT NULL,
  executions  integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, window_hour),

  CONSTRAINT automation_budget_nonnegative CHECK (executions >= 0)
);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, repeated verbatim from
-- packages/db/src/rls.ts, exactly as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE platform.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.automations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automations_tenant_isolation ON platform.automations;
CREATE POLICY automations_tenant_isolation ON platform.automations
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE platform.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.automation_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_runs_tenant_isolation ON platform.automation_runs;
CREATE POLICY automation_runs_tenant_isolation ON platform.automation_runs
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE platform.automation_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.automation_budget FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_budget_tenant_isolation ON platform.automation_budget;
CREATE POLICY automation_budget_tenant_isolation ON platform.automation_budget
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants for the APPLICATION role.
--
-- A restatement, not a creation — see this file's header. `platform` carries
-- ALTER DEFAULT PRIVILEGES from 0001, so taskflow_app already has these. They
-- are written out anyway so that reading this migration tells the truth about
-- what the app role can do, which is the property 0036 found missing when a
-- "SELECT only" grant turned out to be weaker than the database's own default.
--
-- `automation_runs` is deliberately INSERT + SELECT with no UPDATE and no
-- DELETE for the app role's own use: a run row records what happened at a
-- moment, and nothing should be able to rewrite that after the fact. Retention
-- pruning, when it comes, is a migrator or sweep concern with its own role.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.automations TO taskflow_app;
GRANT SELECT, INSERT ON platform.automation_runs TO taskflow_app;
REVOKE UPDATE, DELETE ON platform.automation_runs FROM taskflow_app;
GRANT SELECT, INSERT, UPDATE ON platform.automation_budget TO taskflow_app;
REVOKE DELETE ON platform.automation_budget FROM taskflow_app;

-- --------------------------------------------------------------------------
-- taskflow_automation — the engine's CLAIM role (0016's recipe, fourth use).
-- --------------------------------------------------------------------------
-- The role is created in docker/postgres/init/02-roles.sql, not here — roles
-- are cluster-wide and migrations run as taskflow_migrator, which is
-- NOCREATEROLE on purpose. A database whose volume predates that file fails
-- this migration with "role taskflow_automation does not exist"; the fix is
-- `docker compose down -v && docker compose up -d`, not loosening the migrator.
--
-- What it may do is deliberately tiny, and tinier than it first looks: CLAIM
-- events from the outbox under its own consumer name. That is all.
--
-- It holds NOTHING on platform.automations, automation_runs or
-- automation_budget. Reading which rules exist, recording what happened, and
-- decrementing a budget are all ORG-SCOPED work, done afterward per event over
-- the ordinary taskflow_app connection inside withOrgScope. So the role that
-- decides "which events might fire a rule" cannot read a single rule, cannot
-- write a single run row, and cannot perform a single action — the same
-- claim-only separation taskflow_backlinks has from docs.page_versions, and it
-- matters more here because the thing on the other side of the line is
-- arbitrary mutation of tenant data.

GRANT USAGE ON SCHEMA platform TO taskflow_automation;

GRANT SELECT, UPDATE ON platform.outbox TO taskflow_automation;

DROP POLICY IF EXISTS outbox_automation_read ON platform.outbox;
CREATE POLICY outbox_automation_read ON platform.outbox
  FOR SELECT TO taskflow_automation
  USING (true);

-- WITH CHECK (false), not (true), and the asymmetry is the whole point — the
-- comment 0016 wrote for outbox_realtime_mark, reproduced because it was
-- verified against a real database the hard way: claimPending claims with
-- `SELECT ... FOR UPDATE OF o SKIP LOCKED`, and Postgres's RLS for a LOCKING
-- select requires a row to pass a policy applying to UPDATE. WITHOUT this
-- policy the claim silently returns zero rows, indistinguishable from an idle
-- queue — a gateway that boots cleanly, logs nothing, and does nothing.
-- WITH CHECK (false) permits the lock (a locking select never writes a row, so
-- it never reaches WITH CHECK) and refuses an actual write.
DROP POLICY IF EXISTS outbox_automation_mark ON platform.outbox;
CREATE POLICY outbox_automation_mark ON platform.outbox
  FOR UPDATE TO taskflow_automation
  USING (true)
  WITH CHECK (false);

-- Its own dispatch bookkeeping, pinned to its own consumer name. The WITH
-- CHECK is what keeps one consumer's typo from erasing another's queue: an
-- engine that passed 'audit' to markDispatched would otherwise delete an event
-- from the AUDIT relay's claim, silently losing a compliance entry to a string
-- literal in a different app.
GRANT SELECT, INSERT, UPDATE ON platform.outbox_dispatch TO taskflow_automation;

DROP POLICY IF EXISTS outbox_dispatch_automation_read ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_automation_read ON platform.outbox_dispatch
  FOR SELECT TO taskflow_automation
  USING (consumer = 'automation');

DROP POLICY IF EXISTS outbox_dispatch_automation_insert ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_automation_insert ON platform.outbox_dispatch
  FOR INSERT TO taskflow_automation
  WITH CHECK (consumer = 'automation');

DROP POLICY IF EXISTS outbox_dispatch_automation_update ON platform.outbox_dispatch;
CREATE POLICY outbox_dispatch_automation_update ON platform.outbox_dispatch
  FOR UPDATE TO taskflow_automation
  USING (consumer = 'automation')
  WITH CHECK (consumer = 'automation');
