# Phase 3.5 — Work, to ClickUp-class flow

**Status: COMPLETE 2026-08-05. All three waves shipped.**
All six open questions in §10 were settled as this document recommended — the decisions are
recorded there rather than removed, because the reasoning is what a future reader needs.

Parent: [PLAN.md](../PLAN.md) §10.4 (Views), §10.5 (Frontend state ownership), §13 (Roadmap).
Slice procedure: [feature-template.md](feature-template.md) — contract, permission, migration,
schema, service, route, UI, tests, in that order.

---

## 1. Why this phase exists

Phase 3 delivered a Trello-class product: projects, boards, lists, cards, drag ordering, a table
view, card detail, attachments, and a filter AST that is genuinely stronger than the category
norm. What it did not deliver is **flow** — the sense that the application knows where you are,
what you were doing, and what you are likely to do next.

That gap is not decoration and it is not one missing screen. It is four things:

1. **No spatial model.** A flat top nav and a projects page. Nothing shows the shape of the
   workspace, so every navigation is a round trip through a list.
2. **No personal view.** Every screen is org-or-board scoped. There is nowhere that answers
   "what is assigned to me".
3. **The column IS the row's parent.** Grouping is welded to a foreign key, so there is exactly
   one way to look at a set of cards.
4. **Interactions are round trips.** Drag → mutate → invalidate → refetch. PLAN.md §10.5 already
   requires optimistic mutations on every user-visible interaction; the current build does not
   have them.

Item 4 is worth stating plainly: **a meaningful part of Wave 1 is closing a gap against our own
spec, not adding scope.** §10.5 mandates `onMutate` / `onError` / `onSettled` on every
interaction and names sidebar collapse as legitimate Zustand state. Neither exists yet.

---

## 2. What "same as ClickUp" means here — and what it does not

**In scope: the interaction model.** Persistent hierarchy sidebar, status as a first-class field,
views over one collection, grouping and sorting as view settings, inline creation everywhere,
hover affordances, multi-select with a bulk bar, keyboard-first navigation, a personal home.
These are industry patterns, not anyone's property, and every serious tool in the category
converges on them.

**Out of scope: their visual identity.** No ClickUp logo, icon set, brand palette, illustrations,
marketing copy, or light-theme colour values. TaskFlow keeps its own dark palette
(`apps/web/src/styles.css`) and its own iconography. This is a legal line and a product one:
a clone that looks like a competitor reads as a knock-off, and a tool with its own confident
visual identity does not.

The rule for every decision in this document: **take the flow, keep the face.**

**Also out of scope for 3.5**, deferred by the existing roadmap and not re-litigated here:
Calendar and Gantt/Timeline (Phase 13), global search and the TQL parser (Phase 8), the
notification inbox (Phase 9), automation (Phase 10). Realtime collaboration is Phase 4 and this
phase must not pre-empt it — see §8.4.

---

## 3. The structural decision

> **A card's column is a grouping, not a parent.**

This is the one decision the rest of the phase depends on, and it should be settled before any UI
work starts even though the UI work ships first.

Today `cards.list_id` is a foreign key and the board column IS that FK
([`packages/db/src/schema/work.ts:172`](../packages/db/src/schema/work.ts)). Consequences:

- Cards can only ever be grouped one way.
- "Group by assignee" and "group by priority" are unimplementable without a second mechanism.
- List view, Calendar and Timeline each need their own notion of sections, so the grouping logic
  gets written three more times.

ClickUp's model — and Jira's, and Linear's — is that a task carries a **status**, statuses belong
to the container, and the board's columns are `group by status`. Dragging between columns sets a
field.

### 3.1 What changes

Add `statuses` as a per-project vocabulary and `cards.status_id` as a field. **Keep `list_id`.**
Lists remain the physical board columns and the ranking dimension; status becomes the semantic
one. They coexist:

| Concept  | Owns                                   | Used for                                         |
| -------- | -------------------------------------- | ------------------------------------------------ |
| `list`   | board layout, `rank` scope, WIP limits | the default board grouping, drag ordering        |
| `status` | project vocabulary, done-ness          | grouping, filtering, reporting, automation later |

Migrating lists away entirely is a bigger and more destructive change than this phase needs, and
composite-FK hierarchy enforcement (CLAUDE.md, Phase 3 notes) is built on `list_id`. Keeping both
is the honest expand-migrate-contract move: add the field, teach the UI to group by it, and
revisit collapsing them only if lists turn out to be dead weight.

### 3.2 The ordering problem, stated before it bites

`rank` is scoped to a list. When the board is grouped by anything else, "the order within a
group" has no stored answer.

**Rule:** dragging ACROSS groups sets the group's field (status, assignee, priority). Dragging to
REORDER within a group is only available when grouping is by list, which is the native rank
dimension. Under any other grouping the group is sorted by the view's sort setting and cards are
not individually reorderable.

This is what ClickUp does, it is what the data supports, and writing it down now prevents someone
adding a `rank_by_status` column later to fix a problem nobody actually has.

---

## 4. Wave 1 — Shell and feel

**No migrations. No API changes. ~1–2 weeks.** Entirely `apps/web`.

This wave is where "too basic" mostly lives, and it is deliberately first: it cannot conflict
with the model work in Wave 2, and it is the fastest route to the app feeling different.

### 4.1 The sidebar

New: `apps/web/src/components/sidebar.tsx`, rendered by `Shell`
([`shell.tsx:36`](../apps/web/src/components/shell.tsx)) alongside the existing header.

- Hierarchy tree: **Org → Projects → Boards**, lazily expanded, current node highlighted.
- Pinned/favourite boards at the top, persisted per user in `localStorage` for now (a server-side
  preference belongs with the Phase 12 admin work, not here).
- Collapse toggle. Collapsed state goes in `ui-store.ts` — §10.5 names it explicitly as
  legitimate Zustand state, so no new pattern is needed.
- Footer: org switcher and account menu move here from the header, which shrinks to breadcrumbs
  and page actions.

`OrgSwitcher` moves but does not change behaviour — including the empty-list case and the
`All organizations…` item, which exist for the staleness reasons documented in CLAUDE.md and
must survive the move.

### 4.2 Breadcrumbs and the header

Header becomes `Project / Board` + view tabs + page actions. The current top nav
(Projects / Settings / Permissions) is absorbed by the sidebar.

### 4.3 Optimistic everything

This is the single biggest perceived-speed change and it is already specified by §10.5.

- New `apps/web/src/lib/optimistic.ts`: one helper wrapping the
  `onMutate` snapshot → patch, `onError` rollback + toast, `onSettled` invalidate cycle, so the
  three-step contract is written once rather than remembered thirteen times.
- Apply to: card move (the one that shows most), card create, title/description save, assignee
  toggle, label toggle, checklist item toggle, comment create, list reorder.
- **`useUpdateCard`'s patch semantics must not be bypassed.** Its read-then-patch design exists
  because `cards.update` is a full replace and the naive version erases a description per rename
  (CLAUDE.md, Phase 3). An optimistic wrapper writes to the CACHE optimistically and still sends
  a patch through `useUpdateCard`.

### 4.4 Inline creation

- "+ Add task" at the foot of every column and group. Enter commits and **keeps focus** for the
  next one; Escape closes. This one behaviour is most of what makes a board feel fast.
- "+ Add list" inline rather than a separate form.
- Same pattern in List view when Wave 2 lands.

### 4.5 Hover affordances and density

- Card tile: on hover, quick assignee, quick due date, and an overflow menu. No panel round trip
  for the three most common edits.
- Density pass across `primitives.tsx` — the current spacing is uniform where it should be
  hierarchical.
- Avatars instead of raw ids. Needs a per-org member lookup cached from
  `tenancy.members.list`; new `apps/web/src/features/org/use-members.ts` exposing
  `memberById(userId)`. Initials-based avatar component in `primitives.tsx` — no uploads in this
  wave.

### 4.6 Feedback

- **Toasts.** New dependency: `@radix-ui/react-toast` (consistent with the six Radix primitives
  already in use). Record it in [dependency-exceptions.md](dependency-exceptions.md) if that file
  governs additions.
- **Skeletons** replacing centred spinners on board, table and detail. A spinner in the middle of
  an empty page reads as "broken"; a skeleton reads as "loading".
- Keep `ErrorView` exactly as it is. The request id it renders is the only thread between a
  user's report and a log line, and it should survive every redesign.

### 4.7 Card detail

Widen from the current 28rem side panel
([`card-detail-panel.tsx:63`](../apps/web/src/features/work/detail/card-detail-panel.tsx)) to a
centred modal with a two-column body: content left (title, description, checklists), properties
right (status, assignees, dates, priority, labels, custom fields), activity below.

**It stays route-driven on `?card=`.** §10.5 requires deep-linkable and back-button-correct
detail, and the current implementation is correct — only its presentation changes.

The `key={card.data.cardId}` remount ([line 95](../apps/web/src/features/work/detail/card-detail-panel.tsx))
must survive the rewrite. It exists so switching cards remounts the editor rather than resetting
state in an effect, and the effect version regresses silently the moment a field is added.

### 4.8 Wave 1 acceptance

- Every listed interaction updates the UI before the server answers and rolls back visibly on
  failure.
- A card can be created, assigned and dated without opening the detail modal.
- Sidebar collapse survives a reload; nothing else about navigation depends on it.
- No new `any`, no new `@ts-expect-error`, `pnpm verify` green, guardrail selftest green.

---

## 5. Wave 2 — Status, priority, grouping, List view

**Migrations required. ~2–3 weeks.** Full vertical slice per `feature-template.md`.

### 5.1 Contracts

`packages/contracts/src/ids.ts` — add `StatusId`, branded, constructed only by its parser.

New Zod schemas: `StatusCategory = z.enum(['not_started', 'active', 'done'])`,
`Priority = z.enum(['urgent', 'high', 'normal', 'low'])`.

Priority is **nullable** — "no priority" is a real and common state, and a default of `normal`
makes every card look deliberately triaged when none of them are.

### 5.2 Permission

Two questions, and Phase 3 already settled the principle (CLAUDE.md, card detail notes):

- Managing the status SET is `project:update` — it changes the vocabulary of every card.
- Setting a card's status is `card:update` — it changes one card.

No new actions. No new `RESOURCE_TYPES` entry: a status is not independently grantable, for the
same reason there is deliberately no `list` resource type.

If any new action is added, `packages/policy/src/matrix.test.ts` gets its rows **first** and fails
until the matrix is filled in. That order is the point.

### 5.3 Migration `0011_status`

Paired up/down, expand-migrate-contract, never edited once applied.

```
work.statuses
  id, org_id, project_id, name, category, color, position,
  is_default boolean, created_at
  UNIQUE (org_id, project_id, name)
  UNIQUE (org_id, project_id, id)        -- the composite FK target
  RLS: tenantRlsPolicy('work', 'statuses')
  index leading with org_id

work.cards
  + status_id uuid NULL                   -- NULL in this migration, by design
  + priority text NULL CHECK (priority IN ('urgent','high','normal','low'))
  FK (org_id, project_id, status_id) -> statuses (org_id, project_id, id)
```

The composite FK is not decoration. It is the same control the card hierarchy already uses: RLS
stops a status being read across a **tenant**, and does nothing about a status from another
**project of the same tenant**. The database refuses it, so no service has to remember to check.

**`status_id` is nullable in 0011 and becomes NOT NULL in a later contract migration**, after a
backfill. Adding it NOT NULL with a default would silently assign every existing card a status
nobody chose.

**Backfill** (`0012_status_backfill`): seed each existing project with To Do / In Progress / Done,
then map each card by case-insensitive match on its list name, falling back to the first
`not_started` status. Write the mapping rule in the migration comment — a future reader will want
to know why a card is in a status nobody set.

Verify with `migrate:verify` (up → down → up) before anything depends on it.

### 5.4 Events

Guardrail 6: every state-mutating service method emits a typed domain event, in the mutation's own
transaction.

- `status.created`, `status.updated`, `status.deleted` — vocabulary changes.
- `card.statusChanged` — a first-class event, not folded into `card.updated`. Automation
  (Phase 10) fires on status transitions specifically, and a consumer that has to diff two
  payloads to notice one is a consumer that will get it wrong. `card.moved` is the existing
  analogue for list moves and this is its sibling.
- Priority rides on the existing `card.updated`.

### 5.5 Filter

`packages/filter/src/fields.ts` gains `status` and `priority`.

Both are enum-ish scalars, so the `uuid_array` trap does not apply — but **the parity test does**.
`apps/api/src/work/filter.parity.test.ts` runs both backends over the same rows in real Postgres,
and the whole reason that file exists is that the compiler and the evaluator do not agree by
default. A field added without a parity case is a field that is wrong in one backend, silently,
exactly as `label` was.

`is_empty` must be covered for priority, which is nullable.

### 5.6 Grouping and List view

- `cards.list` already returns every card for a board; **grouping is client-side.** No API change,
  no new query, and the two views cannot disagree about what matched a filter — the property
  `board-page.tsx` is built around.
- New `apps/web/src/features/work/grouping.ts` — pure functions, unit-tested, no React. Group by
  list, status, assignee, priority, or due-date bucket.
- View controls in the board header: **Group by** and **Sort by**.
- **List view** (`list-view.tsx`): collapsible sections, one row per card, inline add per section,
  virtualized with TanStack Virtual as the table view already is. Once grouping is a pure
  function this is largely presentational.
- Drag semantics per §3.2: across groups sets the field; reorder within a group only when grouped
  by list.

### 5.7 Wave 2 acceptance

- Board can be grouped by status, assignee and priority, and dragging between groups sets the
  right field.
- `migrate:verify` passes; no existing card ends up without a status.
- Filter parity test covers both new fields including the null cases.
- Tenancy fuzz harness (`apps/api/src/testing/tenancy-fuzz.test.ts`) names any new mutation
  explicitly, so a route dropping to `not-applicable` fails a test rather than quietly losing
  coverage.

---

## 6. Wave 3 — Saved views, bulk actions, home

**~2–3 weeks.**

- **Saved views** as rows, not URL params: `work.views` with `{ container, type, group_by,
sort_by, filter, visible_columns, is_shared }`. The filter column stores the existing AST —
  which is why the AST shipping in Phase 3 rather than Phase 8 keeps paying off. `@me` stays
  symbolic in a stored filter for the reason §10.2 gives: substituting a user id at save time
  turns a shared view into "assigned to whoever saved it".
- **Multi-select + bulk bar.** Shift-click ranges, a floating action bar, bulk status / assignee /
  label / due date / archive. Server side these are loops over existing routes — resist inventing
  a bulk endpoint that bypasses per-card authorization.
- **My Tasks / Home** — cross-project, assigned to `@me`, grouped by due date. Needs a
  cross-board card query; the filter compiler already supports everything except the scope
  widening.
- **Command palette (Cmd+K)** — navigation and actions only. Search is Phase 8 and this must not
  grow into it.
- **Keyboard shortcuts** — a documented, discoverable set with a `?` overlay.

---

## 7. Wave 4 — Depth

Sized separately, not committed here.

Subtasks (`parent_card_id`, recursive read, roll-up counters — recomputed, never incremented,
per the `counters.ts` rule) · dependencies (blocking / waiting-on, cycle detection) · time
estimate and tracking · recurring cards · watchers.

---

## 8. Cross-cutting obligations

Nothing in this phase suspends the working agreement. The four that will actually come up:

### 8.1 The wire lies about dates

Every new date-bearing output goes through `Wire<T>` and `wire()`. tRPC infers `Date` where JSON
delivers a string, the compiler agrees with the lie, and `format()` silently renders
"Invalid Date". Priority and status are strings, but due-date grouping in Wave 2 is exactly the
code that breaks on this.

### 8.2 The UI never re-derives authorization

Status controls, bulk bars and quick actions are all rendered; the server answers. §8.2 is
explicit that a UI reimplementing `can()` produces two models that drift and the one users see is
never tested.

### 8.3 Tests ship with the slice

A slice with untested authorization is not done. Specifically: `grouping.ts` is pure and gets unit
tests; every new filter field gets a parity case; every new route is enrolled in the fuzz
manifest; any new policy action gets matrix rows before it gets an implementation.

### 8.4 Do not pre-empt Phase 4

Optimistic updates are a cache concern and belong in the mutation. Cross-client invalidation is
the realtime spine's job, from **one module**, per §10.5. Wave 1 must not grow a polling loop or a
socket to make two tabs agree — that is Phase 4's design decision, not this phase's workaround.

---

## 9. Sequencing and cost

| Wave | Delivers                                                                                                           | Migrations | Est.      |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------- | --------- |
| 1    | Sidebar, breadcrumbs, optimistic mutations, inline create, hover actions, avatars, toasts, skeletons, detail modal | none       | 1–2 wks   |
| 2    | Status, priority, group-by, sort-by, List view                                                                     | 0011, 0012 | 2–3 wks   |
| 3    | Saved views, bulk actions, My Tasks, command palette, shortcuts                                                    | 0013       | 2–3 wks   |
| 4    | Subtasks, dependencies, time tracking                                                                              | TBD        | not sized |

**Waves 1–3 ≈ 5–8 weeks.** Wave 4 is a separate decision.

Each wave is independently shippable and independently abandonable. Wave 1 has no schema
dependency, so it can start immediately and in parallel with a decision on §3.

**This pushes Phase 4 back by the same amount**, and Chat, Docs and Voice all sit behind Phase 4.
That is the real cost of this phase and it should be accepted explicitly rather than discovered
later.

---

## 10. Decisions

Settled 2026-07-30. Each was an open question and each went the way this document proposed; the
alternatives are kept because the next person to want one of them should be able to see it was
considered.

1. **Statuses alongside lists, not replacing them.** Replacing is conceptually cleaner and is a
   far larger, destructive migration that would rework the composite-FK hierarchy enforcing the
   project/board/list chain. Lists keep board layout, `rank` scope and WIP limits; status takes
   grouping, filtering and done-ness. Revisit only if lists turn out to be dead weight — which is
   a question this phase will actually answer.
2. **Statuses are per PROJECT**, matching labels and custom fields, which are already
   project-scoped vocabulary (CLAUDE.md, card detail notes). Per board is more flexible and
   multiplies what a user has to maintain by the number of boards, for a benefit nobody asked for.
3. **Priority is NULLABLE.** No default. `normal` as a default makes every card look deliberately
   triaged when none of them are, which destroys the signal the field exists to carry.
4. **No level between Project and Board.** Org → Project → Board stays two deep. ClickUp's
   Space → Folder → List is three, and the third level is organisational tidiness for workspaces
   with dozens of containers — it buys nothing at this size and costs a migration plus a
   permission question (is a folder grantable? if so it needs a `RESOURCE_TYPES` entry and an
   `object_type` CHECK widening). Reconsider when a real workspace has enough projects that the
   sidebar is hard to scan; it is cheaper before Wave 3's saved views than after, so that is the
   deadline.
5. **`@radix-ui/react-toast`**, for consistency with the six Radix primitives already in use.
   Hand-rolling means reimplementing focus management, swipe dismissal and the ARIA live region,
   and getting the live region wrong makes an error invisible to a screen reader — which is the
   one user for whom a toast is the only notification.
6. **The Phase 4 delay is accepted.** Realtime, and therefore Chat, Docs and Voice, slips by the
   length of waves 1–3. See §9.
