# Phase 10.5 — Sprints (Work)

**APPROVED 2026-08-11** (decisions 1–8 as drafted; the reviewer confirmed the two product
calls — unfinished cards return to the backlog on close, one active sprint per project).
Branch: `phase-10.5-sprints`.

**Seeding added 2026-08-12** (in the Phase 10 seed sweep): `packages/seed/src/modules/work.sprints.ts`
gives every project one completed (past, with cards attached), one active (now, with cards
assigned via a scoped `UPDATE work.cards SET sprint_id`), and one planned sprint — the
one-active-per-project index is exercised by construction, and the close transaction's
"done cards stay attached" half is the completed sprint's seeded shape. Card ids come from
the `card.created` events the cards module buffers (`work.sprints` declares `work.cards` as
an ordering-only dependency, reviewer-caught), and `--reset` nulls `cards.sprint_id` before
the teardown loop (the `docs.pages`-cycle pattern — `cards_sprint_fk` has no cascade).

**SLICE 1 (schema + events) SHIPPED 2026-08-11** — migration 0054 (`work.sprints`,
`cards.sprint_id` with the composite project-scoped FK, the one-active partial unique
index, RLS, `REVOKE DELETE`), the drizzle mirror, the five event definitions, and
`packages/db/src/sprints-grants.test.ts` (6 tests: the REVOKE, the index refusing a second
active sprint and allowing one where none exists, the FK refusing another project's
sprint, RLS confinement). Two of the migration's claims are pinned by that suite exactly
because nothing in the application would notice: the REVOKE DELETE and the one-active
invariant are the DATABASE's, not the service's.

Read this header before trusting a status marker anywhere else in this file.

---

## Why this phase exists (PLAN.md §13, ai/phase-11-analytics.md §7 decision 1)

A work tracker without sprints is not competitive — Jira, ClickUp and Linear all have them
because teams genuinely plan in them — and Phase 11's burndown is conventionally per-sprint.
A burndown over an arbitrary date range is a chart no team recognizes. So the sprint gets
built here, as its own Work phase sequenced BEFORE Phase 11, and Phase 11 reads it: the
sprint record's start/end dates and `completed_at` are what its burndown curves compute
against. Shipping the metric first and the concept second means building it twice — not a
saving.

Scope, exactly as PLAN.md §13's row names it: **the sprint record and its lifecycle
(planned → active → completed), card membership and a backlog, what happens to unfinished
cards when a sprint closes, the sprint board and picker, events, permissions, tests.**

## What already exists (checked, not assumed)

- **Project-scoped vocabulary is an established pattern.** `work.statuses`, `work.labels`
  and custom-field definitions are all per-`project_id` — 0011's header says why: per board
  would multiply what a user maintains by the number of boards for no one's benefit. A
  sprint is the same kind of thing: a project's planning unit, not a board's layout.
- **The hierarchy is enforced by composite FKs, not services.** `work.cards` carries
  denormalized `project_id`/`board_id`/`list_id` and references a unique index on `lists`
  that includes its ancestors (0008 note 1). A card's sprint must follow the same rule: the
  FK has to prove the sprint belongs to the card's own project, because `withOrgScope`
  stops cross-tenant writes and does nothing about a same-tenant wrong-project write.
- **`work.statuses.category`** ∈ `not_started | active | done` (0011) is what "finished"
  means, independent of status names. Closure of a sprint keys off it.
- **The board's view settings are URL search params** (`view`, `groupBy`, `sortBy`, `filter`
  on the board route) — a `sprint` param joins them, shareable and back-button-correct like
  the rest.
- **Every state-mutating service method emits a typed domain event** (guardrail 11) —
  `sprint.*` events join the same registry `card.*` events live in, and Phase 11's
  projection can consume them without new instrumentation.
- **No sprint, iteration, or milestone concept exists anywhere.** Nothing to extend; this is
  greenfield within the work schema.

## The model, and the decisions resolved in this draft

1. **A sprint belongs to a PROJECT** (like a status, not like a board). `work.sprints`
   carries `project_id`, and the card's `sprint_id` is constrained by composite FK to the
   card's own project. Cross-project sprints would make the picker a join and the closure
   semantics a negotiation; no team the phase serves asks for them.
2. **A project has AT MOST ONE ACTIVE sprint**, enforced by a partial unique index
   (`WHERE status = 'active'`). Multiple `planned` sprints are fine — that is how teams
   line work up — but two running sprints is a team that has stopped using the tool.
   `cancelled` and `completed` accumulate as the record.
3. **Lifecycle**: `planned → active → completed`, plus `cancelled` from either. The column
   is a `status` with a CHECK on the four values; the SERVICE guards the transitions (you
   cannot complete a planned sprint without starting it, cannot reactivate a completed one).
   A cancelled sprint releases its cards exactly like a completed one (below) — the team
   decided the sprint was not going to happen; the cards were never in it.
4. **The backlog is NOT a row** — it is `cards.sprint_id IS NULL`. The pool of unassigned
   work needs no record, no lifecycle, and no permission of its own; it is the complement of
   membership. This is the model Phase 11's "backlog exists" claim builds on.
5. **What happens to unfinished cards when a sprint closes — RESOLVED: done cards stay,
   unfinished cards return to the backlog.** The completion transaction does two things
   atomically: cards whose status category is `done` KEEP `sprint_id` — the completed sprint
   is a stable record of what shipped, and Phase 11's velocity/burndown reads exactly that —
   and every card not `done` gets `sprint_id = NULL`. Returning to the backlog, not rolling
   to the next sprint: rollover is a product decision teams disagree on, moving them forward
   is one drag, and auto-rollover would silently re-scope the next sprint before anyone
   planned it. The event carries the counts (`shipped`, `released`) so the UI can say what
   the close did without a follow-up query.
6. **Sprints are day-granular** — `starts_on date`, `ends_on date` (a sprint is not an
   instant), with `ends_on >= starts_on`. Completing writes `completed_at timestamptz` — the
   ACTUAL end. Phase 11's burndown uses `completed_at` when present and `ends_on` while the
   sprint is active: the planned date is the curve's target, the actual date is the truth.
7. **Permissions: sprint CRUD is `project:update`, membership changes are `card:update`.**
   The exact split Phase 3 established for the project's other vocabulary: managing the
   project's planning structure (create/start/complete/cancel a sprint) changes every card in
   it, so it is `project:update`; moving ONE card into or out of a sprint changes one card,
   so it is `card:update`. Collapsing them would either stop members planning their own work
   or let them rewrite the project's sprints from a card panel.
8. **Membership change is a first-class event**: `card.sprint_changed` carrying `before` and
   `after` sprint ids, the same shape `card.status_changed` established — a consumer that has
   to diff two `card.updated` payloads to notice a membership change is a consumer that will
   get it wrong. Phase 11's projection and the sprint picker's card counts consume it.

## Schema — migration 0054 (expand only)

```sql
CREATE TABLE work.sprints (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  project_id   uuid        NOT NULL,

  name         text        NOT NULL,
  goal         text,                        -- nullable; most sprints have one

  starts_on    date        NOT NULL,
  ends_on      date        NOT NULL,

  -- planned | active | completed | cancelled — see decision 3. The CHECK keeps
  -- corruption out; the service owns the transitions.
  status       text        NOT NULL DEFAULT 'planned',

  -- Set by the transition, not by the dates: the truth for Phase 11's burndown.
  started_at   timestamptz,
  completed_at timestamptz,

  created_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sprints_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT sprints_name_length  CHECK (length(name) <= 120),
  CONSTRAINT sprints_status_valid CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  CONSTRAINT sprints_dates_ordered CHECK (ends_on >= starts_on),

  CONSTRAINT sprints_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id)
);

-- One active sprint per project (decision 2).
CREATE UNIQUE INDEX sprints_one_active_per_project
  ON work.sprints (project_id) WHERE status = 'active';

-- The card side: a nullable column, constrained to the card's own project (decision 1).
ALTER TABLE work.cards ADD COLUMN sprint_id uuid;
ALTER TABLE work.cards ADD CONSTRAINT cards_sprint_fk
  FOREIGN KEY (org_id, project_id, sprint_id)
  REFERENCES work.sprints (org_id, project_id, id);

-- RLS: the standard generated tenant policy, forced; grants to taskflow_app,
-- same shape as every work table.
```

`cards.sprint_id` is NULLABLE and stays that way (expand-only, like `status_id` in 0011):
the backlog is a legitimate state, not a backfill waiting to happen.

## Events (guardrail 11 — the registry entries)

- `sprint.created` — id, project_id, name, dates, status.
- `sprint.started` — id, project_id, started_at.
- `sprint.completed` — id, project_id, completed_at, **shipped_count, released_count**
  (decision 5's counts, computed in the same transaction).
- `sprint.cancelled` — id, project_id, released_count.
- `card.sprint_changed` — card_id, project_id, **before** (sprint id or null),
  **after** (sprint id or null). Emitted for membership changes AND for every card released
  by a close — the close is a batch of membership changes plus the sprint transition, and
  the events say so.

## Services & routes (`apps/api/src/work`)

- `sprints.create` / `sprints.update` (name, goal, dates — a planned sprint is editable;
  an active one is not, except its goal) — `project:update`.
- `sprints.start` — `project:update`; refuses when another sprint in the project is active
  (the partial index is the backstop, the service is the message).
- `sprints.complete` / `sprints.cancel` — `project:update`; the one atomic transaction of
  decision 5 (release unfinished, keep done, stamp `completed_at`, emit the batch).
- `sprints.list` (per project, for the picker) — `project:read`.
- `cards.assignSprint` / `cards.releaseSprint` — `card:update`, version-bumped like every
  other card mutation; `assignSprint` takes a `sprintId` validated to the card's project by
  the FK.

## The sprint board and picker (decision — one integration point)

The sprint is a **new dimension on the existing board**, not a new board layout:

- The board toolbar gains a **sprint picker**: `Backlog` (cards with no sprint) · the
  active sprint · each planned sprint (with its date range and live card count) · `All`.
  It is a URL search param (`sprint=`), sharing the existing view-settings pattern — a
  sprint board is the same board, filtered, with a shareable link.
- The picker is the same control that opens a small **sprints manager** panel (create,
  edit dates, start, complete, cancel) for whoever holds `project:update` — one surface,
  one vocabulary, matching how statuses are managed.
- The board's existing card drag stays unchanged; dragging a card within a sprint view is
  still a list move. Assigning cards TO a sprint happens in the card detail panel (a
  "Sprint" field, like assignees and due date) and, for the active sprint, by a card-level
  action.

## What is deliberately NOT in this phase

- **Story points / estimates.** Phase 11 decision 3 is explicit: an estimate field is a
  schema change and a position on how teams should estimate; if ever wanted it belongs
  beside the sprint, not in it. Sprints here ship without a point system.
- **Epics, dependencies, capacity planning, time tracking.** All listed in PLAN.md §13's
  Work row as separate items; none are the sprint record.
- **The burndown chart itself.** Phase 11 computes it; this phase builds the concept it
  computes over. The spec's own §3.2 is the contract for what Phase 11 reads.
- **Auto-rollover** of unfinished work into the next sprint (decision 5 — deliberate).
- **Cross-project sprints** (decision 1 — deliberate).

## Tests

- **Schema/grants**: 0054's RLS confinement (org A's scope sees only org A's sprints, as a
  real org-scoped SELECT), the partial-unique-index refusal of a second active sprint (as
  the real role), and the composite FK refusing a card assigned to another project's sprint.
- **Service lifecycle**: planned → active → completed / cancelled transitions; the guards
  (complete a planned sprint refuses; reactivate a completed one refuses); one-active
  enforced through the service AND the index; completion semantics — done cards keep the
  sprint, unfinished cards return to the backlog, both in one transaction with the shipped/
  released counts; cancellation releases everything.
- **Permissions**: a `member` can assign their own cards to a sprint but cannot create or
  close one; `project:update` is not satisfied by a relationship tuple (org-level
  permission, the established rule).
- **Events**: each transition emits exactly its event; `card.sprint_changed` fires with
  before/after for both single moves and the batch release on close.
- **Web**: the picker filter renders the right cards per `sprint=` param; the manager panel
  gates its controls on the server's FORBIDDEN, never on a client-side `can()`.

## Slices

1. **Slice 1 — migration 0054** + `packages/db` schema/helpers + events registry entries +
   the grants/RLS suites.
2. **Slice 2 — services + routes** (the lifecycle, closure semantics, membership) + the
   lifecycle/permission/event suites.
3. **Slice 3 — the board picker + sprints manager + card detail field** + web tests.

## Status

**APPROVED 2026-08-11** — decisions 1, 2 and 5 resolved by the author's call: unfinished
cards return to the backlog on close, one active sprint per project, and the sprint is a
dimension on the existing board rather than a new layout.

**Slice 1 COMPLETE (commit `be421ca`)** — migration 0054 (`work.sprints` + `cards.sprint_id`
composite FK + one-active partial index + REVOKE DELETE), the drizzle mirror, the five
slice-1 events, and the grants/RLS suite (6 tests: REVOKE, index refusal, FK refusal, org
confinement).

**Slice 2 COMPLETE (commit `1124823`)** — `sprint.service.ts` (create/update/start/complete/cancel/
list + `assignSprint`/`releaseSprint`), the routes (`sprints.*` on `project:read`/`project:update`,
`cards.assignSprint`/`cards.releaseSprint` on `card:update`), and `sprint.service.test.ts`
(13 tests: the lifecycle guards, one-active through the service AND the index, decision-5
closure semantics with shipped/released counts, cancellation releasing everything, membership
round-trips with before/after events, the composite-FK 404 for another project's sprint, the
editability rules per status, and the permission split). Two notes:

- The spec's events list named the lifecycle events and membership; guardrail 11 needed one
  more — `sprint.updated` (before/after), because `sprints.update` mutates state and has no
  quiet category. Same shape `status.updated` established.
- The spec says membership changes are "version-bumped like every other card mutation";
  `setCardStatus`/`assignCard` — the two closest precedents — do not bump `cards.version`,
  so `assignSprint`/`releaseSprint` follow them and don't either. Noted here rather than
  silently diverging.

**Slice 3 COMPLETE (commit `f29f9c7`)** — the web surface, all one integration point: the board
`Sprint` picker (All · Backlog · each sprint, active first, with dates and live card counts)
writing a `sprint=` URL param, the sprints manager panel behind it (create/edit/start/complete/
cancel, every control rendered and the server answering per §8.2), and the card detail
`Sprint` field (Backlog plus planned/active sprints; closed ones listed but disabled because a
card in a completed sprint is part of the shipped record). One server-side addition beyond
the slice-2 routes: `sprintId` on the card summary and detail outputs, because a sprint board
is the SAME card query filtered in the renderer (`filterCardsBySprint`, pure and web-tested —
5 tests) — the backlog is `sprint_id IS NULL`, so the filter names it literally. Completing or
cancelling a sprint from the manager invalidates the board's card caches and My Tasks, since
the close releases cards in bulk. Web 330/330, API work 156/156.

**Phase 10.5 COMPLETE** after slice 3 — the last item before Phase 11 (Analytics) and
Phase 10 Wave 4 (Connectors) remain from Priority 4.
