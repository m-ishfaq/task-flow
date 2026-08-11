# Phase 11 — Analytics

Status: **DRAFT — all seven open decisions RESOLVED 2026-08-11 in review; awaiting final
approval to build.** Written 2026-08-11 against `pre-launch-hardening` HEAD, alongside
[ai/phase-10-automation.md](ai/phase-10-automation.md), per `ai/pre-launch-hardening.md`
Priority 4.

**The review overturned this spec's recommendation on burndown, and the correction is the
biggest single change to the roadmap that came out of it.** The draft proposed avoiding
sprints — burndown over an arbitrary date range — on the grounds that iterations are a Work
feature wearing an analytics hat. That reasoning is right and the conclusion drawn from it was
wrong: sprints are not an analytics convenience, they are **table stakes for a work tracker**.
Jira, ClickUp and Linear all have them because teams genuinely plan in them, and a burndown
chart that is not per-sprint is a chart no team recognizes.

So sprints get built properly, as their own Work phase with its own spec —
**Phase 10.5, sequenced BEFORE this one** — and this phase's burndown reads them. Building
burndown twice to save three weeks is not a saving. See §7 decision 1.

**These two specs also interact in one specific way — see §2.4 — and approving Phase 10
decision 7 without reading it would quietly close the only window this phase has to
reconstruct its own history.**

Scope is PLAN.md §13's Phase 11 row and §7.3: velocity, burndown, CFD, cycle time, workload,
chat/call volume, comms spend.

Read this header before trusting a status marker anywhere else in this file.

---

## What already exists (checked, not assumed)

- **`work.statuses.category`** ∈ `not_started | active | done` (migration 0011), with its own
  comment: _"What the status MEANS, independent of its name — a project renaming 'Done' to
  'Shipped' must not break anything asking 'is this card finished'."_ Every metric in this
  phase that needs a notion of "finished" resolves through this column and never through a
  status name. It was written for this.
- **`card.status_changed` is a first-class event carrying `before` and `after`**, and
  `work/events.ts` says why in its own header: _"Automation (Phase 10) fires on status
  TRANSITIONS specifically — a consumer that has to diff two `card.updated` payloads to notice
  one changed is a consumer that will get it wrong."_ The same sentence is the reason this
  phase is buildable at all.
- **Comms spend is already half-shipped.** `apps/api/src/telephony/spend-report.service.ts`
  groups `comms.spend_ledger` by kind over a `sinceDays` window, gated `recording:read`, with
  a route and a test suite (Phase 7 Wave 4). This phase presents it, it does not rebuild it.
- **Volume sources exist and need no new instrumentation.** `chat.messages.created_at`,
  `comms.calls.created_at` / `duration_seconds` / `direction`, `rtc.sessions` for in-app calls.
- **The projection pattern is established four times over** — audit, realtime, search,
  backlinks — with a per-consumer claim in `platform.outbox_dispatch` and per-org work under
  `withOrgScope`. Phase 8's `search.documents` is the closest analogue and the one to copy.
- **`pg_trgm` and `btree_gin` are installed**; no extension work is needed here.

What does NOT exist, and shapes the whole phase:

- **There is no status-transition history anywhere.** `work.cards` holds only the CURRENT
  `status_id` (nullable, added by 0011 as expand-only) alongside `created_at` / `updated_at` /
  `archived_at`. **There is no `completed_at` column.** `updated_at` is the last touch of
  anything — a comment count changing bumps it — so it cannot answer "when did this finish".
- **There are no materialized views in the repo.** `grep 'MATERIALIZED VIEW' packages/db/
migrations/*.up.sql` returns nothing. PLAN.md §7.3 prescribes them; this phase would be the
  first to build one, including the refresh mechanism.
- **There is no sprint, iteration, or milestone concept.** Nothing in any migration defines
  one. Burndown is conventionally per-sprint, so §3.2 has to answer "burndown of what" before
  it can answer anything else.
- **There is no `analytics:*` permission.** The catalog has none, so this phase makes the
  usual three-place change (`permissions.ts`, `roles.ts`, `matrix.test.ts`, matrix test first).
- **Nothing prunes `platform.outbox`** — see §2.4, which is the most important paragraph here.

---

## Goal

Six dashboards that answer questions a team lead actually asks, computed from data the system
already emits, without a second datastore and without live aggregation over transactional
tables.

---

## 1. The one architectural decision

**Every metric in this phase is a question about the PAST, and the transactional schema only
stores the PRESENT.**

A card row knows it is in Done. It does not know when it got there, how long it sat in
Active first, or whether it went back. Velocity, burndown, CFD and cycle time are all
questions about transitions, and none of them can be answered by any query over `work.cards`
no matter how clever.

So this phase's spine is **a transitions projection fed by the outbox** — the fifth consumer
pattern, identical in shape to `search.documents`:

```
card.status_changed ──► analytics relay ──► analytics.card_transitions
                                                   │
                                     (scheduled)   ▼
                                            materialized rollups ──► dashboards
```

Two layers, deliberately, and the split is what keeps PLAN.md §7.3's rule true:

- **`analytics.card_transitions`** — one row per transition: card, board, project, from-status,
  to-status, both resolved to their CATEGORY at transition time, and `occurred_at`. Append-only
  in practice. This is the fact table, and it is small: one row per status change, not per card
  per day.
- **Materialized rollups** refreshed on a schedule — the daily CFD buckets, per-period velocity,
  cycle-time percentiles. Dashboards read these, never the fact table, and never the
  transactional tables. §7.3: _"Materialized views refreshed on a schedule, never live
  aggregation over transactional tables."_

**Category is denormalized at transition time and that is not an optimization.** A project can
rename or re-categorize a status later; if the rollup resolved category by joining
`work.statuses` at query time, re-categorizing one status would silently rewrite last quarter's
velocity. Storing what the category WAS makes history immutable, which is what history means.
This is the same argument `comms.calls.consent_basis` makes for recording why a decision was
taken rather than re-deriving it two years later.

---

## 2. Building the history that does not exist yet

### 2.1 Going forward

The relay consumes `card.status_changed` from the day it ships. Nothing else is needed.

### 2.2 Cards that exist but have never transitioned

A card created before this phase and never moved has no transition row, so it is invisible to
CFD. Its creation IS a transition — from nothing into its initial status — so the backfill
synthesizes one from `cards.created_at` and the card's current status, marked as synthetic.

### 2.3 The real backfill, and the accident that makes it possible

**`platform.outbox` has never been pruned.** `markDispatched` inserts a dispatch row and
never deletes the event; there is no cleanup job anywhere in the repo. Every
`card.status_changed` ever emitted is still sitting in that table with its payload and its
`occurred_at`.

That means the projection can be backfilled by REPLAYING the outbox, and the history goes back
as far as the event has existed (migration 0011, Phase 3.5). This is a genuine piece of luck
rather than a design: nobody decided the outbox would be an event store, it simply was never
cleaned up.

### 2.4 Which is why Phase 10 decision 7 and this phase are the same decision

`ai/phase-10-automation.md` §9 decision 7 proposes pruning `platform.outbox`, correctly, because
an automation engine that writes events compounds unbounded growth.

**If pruning ships before this phase's backfill runs, the history is gone and cannot be
recovered from anywhere else.** The audit log holds the same events, but coupling analytics to
the hash-chained compliance record is a worse dependency (§4), and the app role holds SELECT
only on it by design.

The resolution is an ordering constraint, not a conflict:

> **Either this phase's backfill runs before any outbox pruning ships, or the pruner must
> exclude event names this phase replays until it has.**

Approving Phase 10 without noticing this is the failure mode. It is written down in both files
for that reason.

---

## 3. The six dashboards

### 3.1 Velocity

Cards (optionally weighted, §7 decision 3) entering a `done`-category status per period,
per board or project. Reads the rollup. **Transitions OUT of done are subtracted from the
period they occur in, never from the period that counted them** — a card reopened in March
does not retroactively change February's number, because a chart that changes after you have
reported it is worse than one that is slightly wrong.

### 3.2 Burndown — per sprint, which means Phase 10.5 ships first

Remaining not-done work in a SPRINT, over the sprint's days, against the ideal line.

**This phase does not invent the sprint.** Phase 10.5 (Work — Sprints) builds it: the sprint
record, its lifecycle, card membership, and what happens to unfinished work when one closes.
This phase reads `sprint_id` and the sprint's start/end dates and computes the curve — which
is a small amount of code once the concept exists, and an unrecognizable chart before it does
(§7 decision 1).

A date-range mode is still worth having for boards that do not run sprints, and falls out of
the same computation with a different window. It is the secondary mode, not the definition.

### 3.3 Cumulative flow (CFD)

Count of cards in each category, per day, per board — the classic stacked area. Computed by
walking transitions forward from a starting snapshot, which is exactly what the daily rollup
materializes. This is the metric that most needs the fact table: it cannot be sampled after
the fact, only accumulated.

### 3.4 Cycle time

Time from a card's first entry into an `active` category to its first entry into `done`.
Reported as a distribution (median, p85), never a mean — one card that sat in a backlog for
eight months makes a mean useless and a median unbothered.

**Cards that never reached done are excluded, and the count of them is shown next to the
number.** A cycle-time chart computed only over finished work is survivorship bias with a
median attached; showing "median 4.2 days over 84 cards, 31 still open" is the honest version.

### 3.5 Workload

Open cards per assignee, from `cards.assignee_ids` (a `uuid[]`). Live over the transactional
table, not a rollup, because it is a question about the PRESENT and the array is already
indexed. The one dashboard that legitimately skips the projection.

### 3.6 Volume and spend

Messages per channel per day, calls per day with duration, in-app call sessions — all
straightforward date-bucketed counts, materialized. Comms spend is `spendReport`, already
built; this phase gives it a chart and leaves the service alone.

---

## 4. Why not read the audit log

It holds every event, it is already per-org, and it would need no new projection. It is still
the wrong source, for three reasons:

1. **It is a compliance record with a hash chain.** Every read pattern this phase would add
   becomes a reason not to change the audit schema later, and the chain's verification query
   is already documented as contract-sensitive (its SELECT list and its `ORDER BY` both).
2. **The app role holds SELECT only, by GRANT, deliberately** — and `taskflow_audit` holds
   INSERT and SELECT and no UPDATE or DELETE anywhere. Analytics needs to write rollups; it
   would need a role either way, so nothing is saved.
3. **`card.status_changed` is in the audit projection's UNMAPPED ledger** — written with a null
   resource id, because a card status change has an obvious container and no resource type of
   its own. Reconstructing the card id would mean parsing the payload back out of an audit row,
   which is the projection's job done twice, worse.

---

## 5. Authorization

A new `analytics:read`, Admin-and-Owner (§7 decision 4 asks whether Member joins them).

**The interesting question is not who may open the dashboard — it is what the dashboard
counts.** Every metric here aggregates across boards, and a member with `analytics:read` who
cannot read board X must not learn X's throughput from a chart. Two candidate answers:

- **Scope every query to boards the caller can read**, resolved per request. Correct, and
  turns every dashboard into a per-hit `can()` problem at aggregate scale — the thing Phase 8's
  route does 50 times and this would do thousands of times.
- **Make analytics an org-level capability** that only Admin/Owner hold, on the reasoning that
  they can read every board anyway, and refuse it to everyone else.

_Recommendation: the second, for this phase_, with the first named as the upgrade path if
member-level analytics is ever wanted. It is the honest version of a permission that would
otherwise be quietly approximate. §7 decision 4.

**Rate limiting: analytics is a quota tier**, per PLAN.md §627, which already names
analytics/search/export/telephony as quota-based rather than sliding-window. Reading a rollup
is cheap; refreshing one is not, and a refresh must never be user-triggerable.

---

## 6. The refresh mechanism

Materialized views need refreshing, and this repo has no such mechanism yet. It becomes an
eighth scheduled loop (or the first tenant of `apps/worker`, if Phase 10 decision 1 goes the
other way).

Three properties fixed now:

- **`REFRESH MATERIALIZED VIEW CONCURRENTLY`**, which requires a unique index on the view. A
  plain refresh takes an ACCESS EXCLUSIVE lock and makes every dashboard hang for its duration.
- **Refresh respects `identity.orgs.status`**, the migration 0037 shape — a suspended org's
  rollups are not recomputed.
- **Staleness is DISPLAYED.** Every dashboard shows when its data was last refreshed. A number
  that is four hours old and looks live is how someone makes a decision on Tuesday's data on
  Thursday.

---

## 7. Decisions — RESOLVED 2026-08-11

1. **Burndown's scope — RESOLVED: sprints get built, as Phase 10.5, BEFORE this phase.
   Overturns the draft.**

   The draft offered three options and recommended the cheap one: burndown over an arbitrary
   date range, on the reasoning that introducing iterations is "a Work feature wearing an
   analytics hat and belongs in a Work phase with its own spec." The premise was right; the
   conclusion was not. **A work tracker without sprints is not competitive** — Jira, ClickUp
   and Linear all have them because teams genuinely plan in them — and a burndown that is not
   per-sprint is a chart nobody recognizes.

   The resolution keeps the premise and reverses the conclusion: sprints ARE a Work feature and
   they DO belong in their own phase, so they get one — **Phase 10.5 — Sprints**, sequenced
   ahead of this phase. Scope named there, not here: the sprint record and its lifecycle
   (planned → active → completed), card membership and a backlog, the decision about what
   happens to unfinished cards when a sprint closes, the UI, events, permissions, tests.
   Roughly the size of Phase 8.

   The alternative — ship date-range burndown now and add sprint mode later — saves about
   three weeks and costs building the metric twice. Not a saving.

2. **Rollup granularity — RESOLVED: daily only.** Taken on the draft's recommendation.
   Nothing in §3 asks a sub-day question, and hourly multiplies every rollup's row count by 24
   for a dashboard nobody requested.

3. **Weighted velocity — RESOLVED: count cards.** Taken on the draft's recommendation. An
   estimate field is a Work schema change and a position on how teams should estimate; that is
   a product decision, and if it is ever wanted it belongs in Phase 10.5 beside the sprint,
   not here. Counting cards is honest about what the system actually knows.

4. **`analytics:read` tier — RESOLVED: Admin and Owner of the org, and the platform operator
   sees NONE of it.** Confirmed and sharpened in review.

   Admin+Owner keeps the permission honest rather than approximate: they can already read
   every board, so an aggregate across boards leaks nothing they could not already assemble.
   Member-level analytics would require scoping every aggregate to the boards each caller can
   read — correct, and roughly triples the phase. Named as the upgrade path, not built.

   The sharpening is the operator half, and it is the review's own point: **a platform
   operator has no business seeing a tenant's day-to-day work.** Velocity, cycle time and who
   is behind on what are the tenant's private business, and every additional thing an operator
   can see is something a compromised operator account can take. What the operator needs is
   operational — org count, suspensions, storage, spend, queue health, error rates — which is
   a different dashboard over different data, and it belongs to the platform console
   (§8).

5. **Where the refresh loop lives — RESOLVED: `apps/worker`.** Phase 10 decision 1 resolved to
   build the worker in its Wave 1, and this answers consistently with it. `REFRESH MATERIALIZED
VIEW` is exactly the kind of heavy, latency-insensitive work that should not share a thread
   with request handling.

6. **Retention of `analytics.card_transitions` — RESOLVED: keep forever.** Taken on the
   draft's recommendation. One row per status change is small next to the tables it
   summarizes; revisit if that ever stops being true.

7. **Outbox pruning — RESOLVED: yes, this phase, and only AFTER its backfill has run.**
   Confirmed in review, and it is the other half of Phase 10 decision 7. This phase is both the
   one that needs the accidental hoard and the one that replaces it with a deliberate store, so
   once `analytics.card_transitions` is populated the outbox no longer has to be an event log
   and can be pruned on a retention window. Doing it in either order but this one loses the
   history (§2.4).

---

## 8. What is deliberately NOT in this phase

- ClickHouse or any second datastore. PLAN.md §7.3 names it as the escape hatch _"if any
  dashboard exceeds ~500 ms — but explicitly not day one. Every additional service is
  additional attack surface."_
- Custom/user-defined dashboards or a report builder. Six fixed dashboards first.
- Scheduled report emails — that is a Phase 10 automation action once both exist.
- **Tenant work metrics for the platform operator — deliberately, and this is a privacy line
  rather than a scheduling one.** An operator does not need to know how fast a customer's team
  closes cards; letting them see it means a compromised operator account can read it. The
  operator's own dashboard is a Phase 12 console surface about the PLATFORM — orgs, storage,
  spend, queue depth, error rates — running as `taskflow_platform_admin` with every read
  recorded in the global operator audit log. Different data, different role, different threat
  model, and no screen where one is a filter away from the other (§7 decision 4).
- **Sprints themselves** — the record, the lifecycle, card membership, the UI. Phase 10.5
  builds them; this phase reads them (§7 decision 1).
- Estimates / story points. If ever wanted, they belong beside the sprint in Phase 10.5.
- Predictive anything.
