# Phase 10.6 — Sprint flow and visibility

## Status

**DRAFT 2026-08-12.** Decisions D1–D5 below were proposed and then built the same day at the
author's direction; they are recorded as decisions rather than as a review that happened.

**Slices 1–3 BUILT, uncommitted** (branch `phase-10.5-sprints`):

- **Slice 1** — `listActiveSprints` + the `sprints.active` route, `/projects/$projectId/sprints`
  (`sprints-page.tsx`), and the sidebar's ambient active-sprint line. Authorization deliberately
  mirrors `listProjects` — the route's `project:read` floor plus RLS, NOT a per-project `can()`
  loop — because the sprint line hangs off the project tree and a line that appeared for fewer
  projects than the tree shows would be a second, quieter answer to "which projects are mine".
- **Slice 2** — sprint entries in the command palette (ranked above projects, labelled
  `<sprint> — <project>` so two teams' "Sprint 14" are distinguishable), and an
  All / This sprint / Backlog filter on My Tasks. "This sprint" is membership of ANY running
  sprint, not one chosen sprint: My Tasks spans every board, so a person working in two teams'
  sprints would otherwise lose half their week. Filtered client-side from the `sprintId` the card
  summary already carries — no second query, and no server-side variant of `listMyCards` to keep
  in step.
- **Slice 3** — `completeSprint` takes `moveUnfinishedTo`, and the manager's Complete control is
  a panel showing the attached count with a destination select. 24 service tests.

Two things worth carrying forward from building it:

- **The composite FK is the backstop, not the error path.** A cross-project destination is
  already unwritable — but a foreign-key violation surfaces as a 500, and "that sprint is in
  another project" is a caller error deserving a 404. So the target row is loaded and checked
  before anything is written, which also means a refused close leaves the sprint still running
  rather than completed with its cards stranded.
- **`card.sprint_changed` needed no registry change.** `after` was already nullable for the
  release-to-backlog case, so carrying a sprint id there is additive and every existing consumer
  keeps working. That is what made D1 a new option rather than a change of meaning — and
  `still releases to the backlog when no destination is given` is the test that holds it to it.

- **Slice 4** — `sprint-planning.tsx`, the two-panel backlog ↔ sprint surface, rendered below
  the sprint list on `/projects/$projectId/sprints` rather than on a route of its own: choosing
  WHICH sprint to plan is the list's job, and splitting them would mean navigating away from the
  thing you just decided on.

Two limits recorded rather than hidden, both visible in the UI:

- **One board at a time.** A sprint is project-scoped (0054) but `cards.list` takes a `boardId`
  and there is no project-wide card route — so the panels show one board's cards, and a project
  with several renders a board picker instead of silently choosing the first. A planning screen
  that quietly showed a third of the work would be worse than one that admits its scope. A
  project-wide card read is the honest fix and is its own slice.
- **Moving is a click, not a drag.** The move is one call to the same `assignSprint` /
  `releaseSprint` the card detail panel uses, and a button is keyboard-reachable, announced by a
  screen reader, and testable without simulating pointer physics. Drag-and-drop is the polish
  pass on a working screen, not the thing that makes it work.

Deliberately NOT optimistic, unlike `sprint-section.tsx`'s field: a planning session is a series
of deliberate moves, and a card that appears to cross the gap and then springs back is worse than
one that takes a moment.

**Phase 10.6 slices 1–4 all built. Not committed.**

**This phase revisits two decisions Phase 10.5 resolved deliberately**, and says so here rather
than quietly implementing around them — the habit `ai/phase-7-voice.md` and `ai/phase-8-search.md`
already keep for their own corrections:

- **10.5 decision 5 — "no auto-rollover of unfinished work"**, which shipped as
  `completeSprint` releasing every unfinished card to the backlog and nothing else. D1 proposes a
  DESTINATION at close time. The original decision is not wrong; it is incomplete for a team
  running back-to-back sprints (see "Why this exists").
- **10.5's "the sprint is a dimension on the existing board rather than a new layout"**, which
  shipped as a `sprint=` URL param on `/boards/$boardId` and a manager panel behind the picker.
  D2 proposes real routes and an ambient active-sprint surface. The board picker STAYS — this
  adds addresses, it does not move the board.

Neither revision changes the schema. `work.sprints` and `cards.sprint_id` (migration 0054) carry
everything below except D1's audit of where cards went.

## Why this exists

Phase 10.5 is complete and correct, and the sprint is still nearly invisible in the product.
Checked against the running app rather than assumed:

- **A sprint has no URL.** `router.tsx` has `/projects`, `/projects/$projectId`,
  `/boards/$boardId`, `/home`, `/chat`, `/docs`, `/calls`, `/search`, `/people` — and nothing for
  sprints. A sprint's only address is `?sprint=` on a board, so **one person cannot send another
  a link to a sprint.**
- **The sidebar never mentions sprints.** It lists My tasks, Chat, Docs, People, then every
  project and (on expand) every board. A running sprint is not visible anywhere without opening
  a board and noticing a dropdown.
- **The command palette has no sprint entries**, though it has boards, projects and My tasks.

The result is that the planning unit teams actually work in day to day sits three levels deeper
than the containers it lives in. Jira puts _Backlog_ and _Board_ top-level under a project and
makes the board the active sprint; ClickUp gives sprints their own sidebar folder; Linear shows
the current cycle's progress inline. The common property is that **the running sprint is visible
without clicking anything**, which is what makes it a daily surface rather than a settings
screen.

The flow half is narrower and sharper. `completeSprint` already does the thing teams do by hand —
done cards stay attached as the shipped record, everything else is released in one transaction —
but it can only release to the BACKLOG. A team running consecutive sprints then re-drags the same
unfinished cards into the next one every fortnight, which is the manual step the automation was
meant to remove, relocated rather than eliminated.

## What already exists (checked, not assumed)

Phase 10.5, all three slices, `ai/phase-10.5-sprints.md`:

- **Migration 0054** — `work.sprints` (project-scoped like statuses/labels), `cards.sprint_id`
  with a composite FK `(org_id, project_id, sprint_id)`, a partial unique index making at most
  one `active` sprint per project a database fact, `REVOKE DELETE`. The backlog is
  `sprint_id IS NULL`, not a row.
- **`sprint.service.ts`** — `listSprints`, `createSprint`, `updateSprint`, `startSprint`,
  `completeSprint`, `cancelSprint`, `assignSprint`, `releaseSprint`.
- **Routes** — `sprints.*` on `project:read`/`project:update`; `cards.assignSprint` /
  `cards.releaseSprint` on `card:update`. `sprints.list` takes ONE `projectId`.
- **Web** — the board `Sprint` picker writing `sprint=`, the manager panel behind it, the card
  detail `Sprint` field, and `filterCardsBySprint` (pure, web-tested).
- **Events** — `sprint.created/updated/started/completed/cancelled`, `card.sprint_changed`.

Nothing below rebuilds any of it.

## Decisions to resolve

**D1 — `completeSprint` gains a destination.** _(supersedes 10.5 decision 5)_
Proposed: the close takes `moveUnfinishedTo: SprintId | null`, defaulting to `null` (today's
behaviour, so an un-updated caller is unchanged). A non-null target must be a `planned` or
`active` sprint **in the same project**, which the existing composite FK already guarantees at
the database level and the service re-checks for a clean 404. Done cards still stay attached
regardless — that is the shipped record and is not a destination question.

The event stays `card.sprint_changed` per card with `before`/`after`, so `after` naming the next
sprint rather than `null` needs no registry change and the audit projection keeps working.

**D2 — sprints get real routes.** _(supersedes 10.5's "a dimension, not a layout")_
Proposed: `/projects/$projectId/sprints` (the list and planning surface) and
`/sprints/$sprintId` (one sprint). The board's `sprint=` picker is UNCHANGED — a sprint remains
a filter on the board, and additionally becomes an addressable thing. Two views of one record,
which is what `/boards/$boardId` and My Tasks already are for cards.

**D3 — how the sidebar learns the active sprint.**
Proposed: a new `sprints.active` route (`project:read`) returning the active sprint for EVERY
project the caller can read, in one query — `{ projectId, sprintId, name, endsOn, cardCount }`.
The alternative, calling `sprints.list` per project, is N queries for N projects and only works
when a project is expanded, which defeats ambient visibility. One route, one query, cached like
`projectsQuery`.

**D4 — estimates stay out.** 10.5 excluded story points, and Phase 11 decision 3 calls an
estimate field a position on how teams should estimate. Nothing here needs them: visibility,
addressing and a close destination are all orthogonal. Velocity and burndown remain Phase 11's.

**D5 — My Tasks gains a sprint dimension, not a new page.** Proposed: a filter/group toggle on
the existing `/home`, not a second screen. "What am I doing this sprint" is the same question
My Tasks already answers, narrowed.

## Slices

Built in order; each is independently shippable and leaves the app working.

### Slice 1 — addresses and ambient visibility (D2, D3)

The largest visible change, and it touches no existing behaviour.

- **`sprints.active`** (D3) — the one new route. `project:read`, no input, returns at most one
  row per project. Service reads `work.sprints` where `status = 'active'` joined to the
  projects the caller can read, with the same per-card count `listSprints` computes.
- **Routes** — `/projects/$projectId/sprints` and `/sprints/$sprintId`, both parsing their
  params with the shared id schemas (the URL is a trust boundary, §Phase 3).
- **Sidebar** — under each project row, the active sprint as one line: name, days remaining,
  card count. Absent when a project has none, which is the common case for a project that does
  not run sprints and must not add noise to it.
- The board picker and manager panel are untouched.

### Slice 2 — palette and My Tasks (D5)

- Command palette: "Go to sprint…" over the active sprints, plus the manager for the current
  project — matching how boards already appear.
- `/home`: a sprint filter (Active sprint · Backlog · All), reusing `filterCardsBySprint` rather
  than a second implementation.

### Slice 3 — the close destination (D1)

- `completeSprint` takes `moveUnfinishedTo`; the service validates the target's project and
  status, and the bulk update writes it instead of `null`.
- The manager's Complete control becomes a small dialog: _"12 unfinished cards → [Next sprint ▾ /
  Backlog]"_, showing the counts BEFORE the action, since the counts are the whole decision.
- `sprint.completed`'s payload gains the destination so the audit record says where work went.

### Slice 4 — the planning view

The two-panel screen `/projects/$projectId/sprints` grows into: backlog on one side, the selected
sprint on the other, dragging between them calling the existing `assignSprint` / `releaseSprint`.
This is where sprint planning actually happens in the tools this product is measured against, and
a filtered board does not replace it.

## Tests

- **`sprints.active`**: returns one row per project with an active sprint and none for projects
  without; a member who cannot read a project never sees its sprint; two projects with active
  sprints both appear (the one-active index is per project, not per org).
- **D1 close**: unfinished cards land in the NAMED sprint, done cards stay attached; a target in
  another project is refused (404, the composite-FK path); a `completed` target is refused; the
  default with no target still releases to the backlog, byte-for-byte the 10.5 behaviour — that
  assertion is what proves this is additive.
- **Routes**: a sprint id for another org's sprint 404s rather than rendering an empty shell.
- **Sidebar**: a project with no active sprint renders no sprint line (the noise case).

## Explicitly not in this phase

- Story points, velocity, burndown (D4 — Phase 11).
- Auto-CREATING the next sprint on a cadence. D1 lets a team send work to a sprint that exists;
  it does not decide when sprints exist.
- Cross-project sprints (10.5 decision 1, unchanged).
- Epics, dependencies, capacity planning (PLAN.md §13 lists each separately).
