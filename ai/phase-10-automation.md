# Phase 10 — Automation & integrations

Status: **APPROVED 2026-08-11 — WAVE 1 SHIPPED 2026-08-11.** All nine open decisions resolved
in review before building. Written 2026-08-11 against `pre-launch-hardening` HEAD, per
`ai/pre-launch-hardening.md` Priority 4 (each remaining priority is its own multi-week phase
and wants its own spec written and approved before implementation). Phase 8 followed this
route and it worked; this is the same route.

**Waves 2–4 (webhooks, public API, connectors + the cost-bearing actions) are NOT started.**
Wave 1 is the engine and nothing else, which is what the wave list below says it is.

**Two recommendations were overturned in that review, and both were overturned correctly:**

- **`apps/worker` is now built in Wave 1** (§9 decision 1). The draft argued for keeping the
  engine on a timer inside `apps/api`, on the grounds that moving seven working loops is its
  own project. That conflated two separate things: nothing requires the existing loops to move
  in order for NEW work to run elsewhere. And the load argument is stronger than the draft
  allowed — the seven existing loops are small drains, while this engine evaluates rules per
  event, runs actions through the full service layer, and (Wave 2) makes outbound HTTP calls
  with retries. Node executes that on the same thread serving requests, so a slow webhook
  receiver becomes a slow board.
- **Cost-bearing actions are IN scope** (§9 decision 3), behind an off-by-default env
  capability flag and their own separate spend sub-budget — not deferred as the draft proposed.
  See §5.5, which is new and is where the sub-budget is specified.

Scope is PLAN.md §13's Phase 10 row and §10.3: a cross-product rules engine with loop
protection and run history, outbound webhooks, a public API with scoped tokens, Slack/GitHub
connectors, and importers/exporters. It also builds **`apps/worker`**, which PLAN.md §6 has
listed as "arriving" since Phase 0.

### Wave 1 — COMPLETE, all six slices, 2026-08-11

Verified: `pnpm verify` **57/57 tasks**, `migrate:verify` up → down → up, the RLS checker
across 96 migrations, and the guardrail selftest 11/11. **Not verified in a browser** — the
standing caveat this repo keeps re-learning, and the reason the automations page shipped with
three gaps a single click found (see the addendum below).

Deliberately granular, because "the engine" is not one reviewable change:

1. **`apps/worker`** — the process, empty on purpose. Validated env, two-tier health, Dockerfile,
   compose service. Its env schema was written `.strict()`, passed five tests fed a tidy fixture,
   and died on first boot listing 200 OS variables — the failure `apps/api/src/config/env.ts`
   already documents happening to IT, repeated. The regression test now feeds realistic noise.
2. **Migration 0047** — `automations`, `automation_runs`, `automation_budget`, the
   `taskflow_automation` claim role, `causationDepth` on the envelope. `platform` carries
   `ALTER DEFAULT PRIVILEGES`, so `taskflow_app` had UPDATE/DELETE on run history before this
   migration's own GRANT ran (the 0036 trap); the explicit REVOKEs fix it and
   `automation-grants.test.ts` proves they took, by asking the database rather than reading the
   migration.
3. **The engine** — trigger matching, conditions through the Phase 3 evaluator, all four loop
   layers, run recording. **Migration 0048** came out of writing the relay: 0047 put the depth on
   the envelope and nothing persisted it, so every chain would have restarted at 0 on the far
   side of the queue. The raw-SQL guardrail also fired, correctly, on the budget upsert written
   inline in the worker — moved to `packages/db` as a named function.
4. **The executor** — actions through `apps/api`'s service layer, the rule owner re-resolved on
   every execution, and the engine started in `main.ts`. Verified by booting the worker against a
   real database: it claimed 1,000 events and executed none, which also proves the claim role's
   `FOR UPDATE`/`WITH CHECK (false)` policy pair, since a wrong one returns zero rows and looks
   identical to an idle queue.

5. **Routes and the rule CRUD service** — plus the kill switch as its OWN route, so stopping a
   misbehaving rule does not have to pass the validation that might refuse it. `createdBy` is
   never touched by an edit: it is whose permissions the rule acts with, so letting an update
   move it would turn "rename this rule" into "re-point this rule at my own privileges". §9
   decision 4 landed here too — the three `*:manage` permissions joined
   `ORG_LEVEL_PERMISSIONS`.
6. **The UI** — `/automations`, with the BOARD'S OWN filter builder as the condition editor.
   Not a similar component: the same one, editing the same `FilterNode` the compiler consumes
   and the evaluator runs. §10.2's split paying off end to end.

**Addendum — the page shipped create-only, and hid what rules do.** Found by looking at it,
not by any test:

- A rule could not be EDITED. `automation.update` existed with no caller — the unreferenced-
  route shape this repo keeps finding in older phases, introduced fresh in a new one.
- The row said "3 actions" — a count of exactly the facts a reader opens the page for.
- Run history showed no per-action outcome, though the engine records `action_results`
  precisely so a partially-applied rule is diagnosable. It stops at the first failure, so
  "action 2 failed" also means action 3 never ran, and a count hid both halves.

All three fixed the same day. The lesson is the one already at the top of this file: a green
suite is not the claim "this works when you click it."

**One test was passing for the wrong reason and is worth repeating here**: a budget assertion
read `automation_budget` with no org scope, and that table FORCEs RLS — so "no budget row" was
true whether or not one had been written. It would have passed even if the control it tested had
been removed entirely.

Read this header before trusting a status marker anywhere else in this file — the standing
lesson every `ai/phase-*.md` in this repo states for itself, and the one Phase 8's Wave 3 had
to learn the hard way six commits ago.

**One thing this phase must NOT get wrong, restated at the top because it is invisible from
inside this file:** Phase 11's only route to historical data is replaying `card.status_changed`
out of `platform.outbox`, which nothing has ever pruned. **This phase does not prune it** —
see §9 decision 7 and [ai/phase-11-analytics.md](ai/phase-11-analytics.md) §2.4.

---

## What already exists (checked, not assumed)

Grepped against HEAD, not taken from PLAN.md's own description of itself. This phase is
unusually well-provisioned — most of its primitives were built by earlier phases that named
Phase 10 as their reason.

- **The event bus is real and has four working consumers.** `platform.outbox` +
  `platform.outbox_dispatch` (migration 0015) give every consumer its own claim under its own
  name. Four relays already mirror the shape this engine needs: `tenancy/relay.ts` +
  `audit.projection.ts` (exactly-once, own role), `apps/realtime/src/relay.ts`,
  `docs/backlinks.relay.ts` (claim cross-tenant as a narrow role, work per-org under
  `withOrgScope`), and `search/indexer.relay.ts`. **The engine is a fifth consumer, not a new
  subsystem** — PLAN.md §10.3's "a few hundred lines of orchestration" is a fair estimate.
- **Guardrail 6 already guarantees the triggers exist.** Every state-mutating service method
  emits a typed event, enforced by lint. There is no trigger this phase has to go and add
  instrumentation for.
- **The condition engine shipped in Phase 3.** `evaluate(resource, node, row, { viewerId, now })`
  in `packages/filter`, parity-tested against the SQL compiler over real Postgres
  (`apps/api/src/work/filter.parity.test.ts`). §10.2's whole split — "the AST ships in Phase 3;
  Phase 10's automation conditions reuse the same evaluator" — was designed for this moment,
  and Phase 8 then added the TQL text frontend, so a rule's condition can be typed as text and
  round-tripped like a board filter.
- **Both token kinds this phase needs are already minted, with no callers.**
  `packages/security/src/tokens.ts` defines `TOKEN_PREFIX.apiToken = 'tf_pat'` ("Long-lived
  programmatic access. Shown once at creation.") and `TOKEN_PREFIX.webhookSigning = 'tf_whs'`
  ("Signs an outbound webhook body so the receiver can verify us."). Same shape as Phase 7
  Wave 1's spend gate and Phase 13's TURN gate: the primitive shipped before the feature.
- **The SSRF gate exists in both halves.** `packages/security/src/outbound-url.ts` —
  `isAllowedUrl` for the URL shape and `isBlockedAddress` for the resolved IP, with its own
  header explaining why a hostname check alone is worthless and why the caller must call both.
  `fetchUnfurl` in the API is the worked example. Outbound webhooks reuse this rather than
  inventing a second check; the IPv6 link-local finding from Priority 2 is already fixed here.
- **Five permissions exist in the catalog with ZERO consumers**: `automation:manage`,
  `webhook:manage`, `integration:manage`, `apiToken:create`, `apiToken:revoke`. The last two
  are already in `ORG_LEVEL_PERMISSIONS` ("minting your own API credentials will never be
  something a resource tuple grants"), and `decide.test.ts` already asserts a tuple cannot
  satisfy `apiToken:create`. The first three are NOT in that list — an omission rather than a
  decision, since nothing has ever used them — and §9 decision 4 resolved to add all three.
- **The spend chokepoint exists.** `checkOutboundAllowed` is the one gate every outbound
  telephony action passes; §10.3's "actions with cost additionally check the spend cap" is a
  call to an existing function, not a new control.
- **The org freeze exists and is already respected by four sweeps.** `identity.orgs.status`,
  joined by the notification sweeps since migration 0037. An automation engine is exactly the
  kind of background actor PLAN.md §8.5 had in mind when it said a kill switch that only runs
  where a user is waiting is not a kill switch.
- **`work.statuses.category`** ∈ `not_started | active | done` (migration 0011) — the semantic
  "is this card finished" independent of what a project renamed its column to. Rules like
  "when a card enters Done" resolve through this, never through a status NAME.
- **The envelope already anticipates this phase.** `DomainEvent.actorId` is
  `UserId | null`, and its comment says null means "the system did it (a retention sweep, **a
  scheduled automation**)" — written before either existed.

What does NOT exist, and matters:

- **`apps/worker` does not exist.** PLAN.md's layout says "(arriving: worker)" and it has not
  arrived. All seven background loops (`tenancy/relay.ts`, `search/indexer.relay.ts`,
  `docs/backlinks.relay.ts`, `chat/retention.scheduler.ts`, `telephony/ingest.scheduler.ts`,
  `platform/digest.ts`, `platform/due-reminders.ts`) run on `setInterval` inside `apps/api`.
  **This phase builds it** (§9 decision 1) and puts only new work in it; the seven stay.
- **No `platform.automations`, `automation_runs`, `webhooks` or `integrations` tables.**
  PLAN.md §365 lists them in the `platform` schema; the schema today has `outbox`,
  `outbox_dispatch`, `notifications`, `notification_deliveries`, `notification_prefs`,
  `push_subscriptions`, `attachments`, `operators`, `flag_overrides`, `operator_audit_log`,
  `socket_io_attachments`. The four this phase needs are unbuilt.
- **The envelope has no causation or depth field**, and `EventEnvelopeSchema` is `.strict()`.
  Loop protection has to put depth somewhere; §9 decision 2 resolved it onto the envelope as
  an additive-optional field, so an event written by an older build reads as depth 0.
- **Nothing prunes `platform.outbox`.** `markDispatched` inserts a dispatch row and never
  deletes the event; there is no cleanup job anywhere in the repo. The table grows forever
  today. That is survivable at current volume and stops being survivable when an engine starts
  writing events that trigger events (§4.4).

---

## Goal

A rule a non-programmer can build in the UI — _when a card enters Done, post to #releases and
update the runbook page_ — that runs through the same service layer a human would, and that
cannot take the system down when someone writes a rule whose action fires its own trigger.

The two halves of that sentence pull in opposite directions, and every design decision below
is a consequence of which one wins where.

---

## Waves

Four, each shipping something reviewable on its own. The ordering is deliberate: the two
waves that can spend money or reach the internet come AFTER the engine that would drive them,
so the engine is proven before it is pointed at anything irreversible — except the parts of
each gate that ship early, which follow Phase 7 Wave 1's rule that a gate ships before the
thing it gates.

- **Wave 1 — `apps/worker` and the engine.** The new worker process (§9 decision 1),
  `platform.automations` + `platform.automation_runs`, the fifth outbox consumer, trigger
  matching, conditions through the existing evaluator, and the four loop-protection layers
  (§4). Actions limited to the ones with no external effect and no cost: move card, set field,
  assign, add label, create/update doc page, post chat message, send notification. The rule
  builder UI, the run-history UI (§9 decision 8), run history and a kill switch all ship in
  this wave, not later.
- **Wave 2 — outbound webhooks.** `platform.webhooks`, HMAC signing with the existing
  `tf_whs` prefix, delivery attempts with backoff and a dead-letter state, and the SSRF gate
  applied per redirect hop. This is the first action that reaches a network the org does not
  control.
- **Wave 3 — the public API and scoped tokens.** `tf_pat` tokens with per-token scopes, a
  quota-based rate limit (PLAN.md §627 names analytics/search/export/telephony as the
  quota tier). §9 decision 5 resolved the surface question: one API, the existing tRPC
  router with token auth.
- **Wave 4 — connectors, import/export, and the cost-bearing actions.** Slack and GitHub as
  the two named integrations, plus CSV/JSON importers and exporters. A connector is a webhook
  with a known shape and an OAuth credential, so everything here is built on Waves 2–3's
  primitives. **`place call` / `send SMS` land here too** (§5.5) — last, behind an
  off-by-default env flag and their own sub-budget, once the engine, its loop protection and
  its run history have all been exercised on actions that cannot cost anything.

---

## 1. The rule model

`trigger → conditions → actions`, exactly PLAN.md §10.3.

### 1.1 Triggers

A trigger is an EVENT NAME plus an optional resource scope (this board, this space, this
channel). It is not a new concept — the registry already holds every name, and a rule's
trigger is a key into it, validated at write time the same way `fields.ts` validates a filter
field. A trigger naming an event this build does not register is refused at the route, not
stored and silently never fired.

Scheduled triggers (`schedule`) are the one exception and are genuinely different: they have
no event to key on. They are a cron expression evaluated by a sweep, producing a synthetic
event with `actorId: null` — the case the envelope's own comment already describes.

### 1.2 Conditions

The stored `FilterNode`, evaluated by `packages/filter`'s existing evaluator against a ROW the
engine assembles from the event's resource. Two things follow from reusing it rather than
writing a second one:

- **A condition means the same thing on a board and in a rule.** That is the whole payoff of
  §10.2's split, and the parity suite is what makes it true rather than intended.
- **`@me` has no meaning in a rule and must be refused at write time.** There is no viewer.
  A rule saved with `assignee = @me` would either throw at execution or, worse, resolve
  against whoever happened to save it — the identical trap `work.views` documents for shared
  views and `search.searches` documents for shared searches, in a context with no user at all
  to fall back on. The evaluator takes `viewerId` as optional; the RULE VALIDATOR must reject
  the symbol.

### 1.3 Actions

An action is a typed, closed union — never a script, never a template string that becomes
code. Each variant names a service method that already exists and the arguments it takes,
validated by Zod at write time and re-validated at execution.

**Actions execute through the service layer**, as PLAN.md §10.3 requires, which buys audit,
events, broadcasts, notifications and search indexing for free. It also means every action
emits its own event, which is precisely what makes §4 necessary.

The actor for an automation-run action is the RULE'S OWNER, not the person whose action
triggered it. This needs stating because both answers are defensible and they differ in a way
that matters: attributing a rule's card move to whoever dragged the card into Done makes the
audit log say a person did something they did not do, and attributing it to the rule's owner
correctly records who set up the behaviour. The event's `requestId` ties the chain back to the
originating HTTP call for anyone reconstructing it.

---

## 2. Authorization — the question this phase gets wrong if it is not explicit

**A rule is a stored capability, and its danger is that it runs later, unattended, as
somebody.**

`automation:manage` governs creating and editing rules. That is the easy half. The hard half:
**what may a rule's ACTION do?**

The answer this spec proposes: **every action is authorized against the RULE OWNER's
permissions, re-resolved at EXECUTION time, never at save time.** Three consequences, all
intended:

- A member who cannot delete cards cannot write a rule that deletes cards.
- A rule written by an owner who is later demoted, or removed from the org, **stops working**
  rather than continuing to act with privileges its author no longer has. This is the same
  reason `resolveOrgMembership` reads the role per request instead of trusting a token claim:
  a demotion has to take effect immediately, and a stored rule is a token that never expires.
- The permission check is a real `can()` with a real Target, not a role-only call, because
  every action names a specific resource — which means a rule can be narrowed by relationship
  tuples exactly like a person can.

The alternative — authorize at save time and run as system afterwards — is simpler, faster,
and turns every rule into a permanent privilege escalation the moment its author leaves. It is
rejected.

**A disabled or unauthorized rule records a run with a refusal reason.** It does not fail
silently. §3's run history exists as much for "why did my rule stop working" as for debugging.

---

## 3. Run history

`platform.automation_runs`, one row per rule execution: rule id, triggering event id, status
(`succeeded | failed | refused | skipped`), the condition verdict, per-action outcomes, depth,
duration, error.

Three properties worth fixing now rather than discovering later:

- **A run row is written even when the condition did not match** (`skipped`). "My rule did not
  fire" is the single most common question a rules engine gets asked, and a history that only
  records successes cannot answer it.
- **It is a projection, not a ledger.** Automation runs are operational telemetry, not
  compliance records — the audit log already holds the actions themselves, through the service
  layer. So runs are prunable on a retention window, unlike `audit.audit_log`.
- **Failure is per-ACTION, not per-run.** A rule with three actions where the second fails
  must record which one, and must not silently skip the third or silently retry the first.
  §9 decision 6 resolved it: a partial failure stops the run and does not retry.

---

## 4. Loop protection — mandatory, day one

PLAN.md §10.3 says "built day one", and the reason is structural rather than cautious: because
actions run through the service layer, **every action emits an event, and every event is a
potential trigger.** A rule whose action fires its own trigger is not an exotic mistake — _when
a card is updated, set a field_ is a plausible thing for a person to build, and it is an
infinite loop.

Four layers, in the order they run:

1. **Depth.** Every execution carries a counter; an event produced by an automation carries
   its parent's depth plus one, and a rule does not fire above a hard cap (proposed: 5). This
   is the layer that stops the two-rule mutual-trigger cycle that no single-rule check can see.
2. **Self-trigger refusal.** A rule whose action would emit the event that triggered it, on
   the same resource, is refused at SAVE time where it is statically obvious, and at execution
   otherwise. Static refusal is a usability feature; the runtime check is the control.
3. **Per-org hourly execution budget**, in Postgres, not in process. The in-process version
   forgives everyone on restart, which is the state an attacker restarts you to reach — the
   identical argument Phase 13's TURN issuance budget makes, and the identical mistake the
   telephony velocity limiter is explicitly allowed to make only because a durable spend ledger
   sits behind it.
4. **The kill switch.** Per-rule `enabled`, and a per-org global disable that an operator can
   set from the Phase 12 platform console. `identity.orgs.status` is already honoured
   independently, so a suspended org's rules stop regardless.

**Depth cannot live in the payload**, because payloads are per-event schemas owned by their
slices. §9 decision 2 resolved it onto the envelope, as an additive-optional field.

---

## 5. Outbound webhooks (Wave 2)

The first thing in this codebase that deliberately makes a request to a URL a USER chose, on a
schedule, without a person watching. Link unfurls do this already, which is why the gate exists
— but an unfurl is one fetch triggered by a human pasting a link, and a webhook is a standing
instruction.

- **Signing**: HMAC over a canonical body with the `tf_whs` secret, timestamped, so a receiver
  can verify us. The mirror image of `twilio-signature.ts`, which verifies THEM — same
  primitive, opposite direction, and worth reading that file before writing this one.
- **The SSRF gate applies per REDIRECT HOP.** `outbound-url.ts`'s own header is explicit that
  the check has to be re-applied to every hop and that only the caller knows what its HTTP
  client did. A webhook client that follows redirects with the check applied only to the
  first URL is a fully working SSRF with a passing test suite.
- **Delivery is at-least-once with backoff and a dead-letter state**, and the receiver is told
  to deduplicate on the event id. Exactly-once delivery to a third party is not achievable and
  pretending otherwise produces a retry policy that drops events.
- **A failing endpoint is disabled after a threshold**, with the org notified. An endpoint that
  has been 500ing for a month is a queue that costs money and delivers nothing.

### 5.5 Cost-bearing actions and the automation sub-budget (§9 decision 3)

`place call` and `send SMS` are available only when
`AUTOMATION_TELEPHONY_ACTIONS_ENABLED` is true, and when they run they pass
`checkOutboundAllowed` exactly as a human-initiated call does — same geo table, same org
freeze, same subaccount check, same rolling cap, same velocity limiter. Nothing about that
chain is reconfigured for automation.

**What IS added is a second, narrower budget, because unattended spend is a different risk
from attended spend.**

The existing cap is one number per org: `comms.spend_policy.cap_cents` (default 2500 —
$25 — over `window_days`, default 30). It is per-ORG and in the DATABASE, deliberately: a
trial org and an enterprise customer need different ceilings, an env var is one value for the
whole deployment, and changing an env var needs a redeploy at exactly the moment you least
want one. That design is correct and this phase does not touch it.

But a single shared cap means **a runaway rule can consume the allowance a human needs for a
real customer call**, and the human finds out by being refused. So automation-initiated spend
gets its own sub-limit within the org's cap — a percentage or a flat cents value on
`comms.spend_policy`, checked in addition to (never instead of) the org cap. A broken rule
burns its own allowance and stops; the phone still works for people.

Two supporting details:

- **The ledger already distinguishes rows by `kind`**, so attributing spend to automation is
  a new kind rather than a new table — the same column `spendReport` already groups by.
- **A deployment-wide ceiling in env** (`TELEPHONY_MAX_ORG_CAP_CENTS`), refusing to honour any
  per-org cap above it. This is the safety net for a self-hosted or development instance where
  somebody sets a cap with too many zeroes; it constrains the maximum, it never grants
  anything.

---

## 6. Public API + scoped tokens (Wave 3)

- `tf_pat` tokens, hashed at rest (`tokens.ts` already returns `{ token, hash }` and its own
  comment says the plaintext must never be logged, persisted, or audited).
- **Scopes are a SUBSET of the holder's permissions, never a superset**, re-resolved per
  request against the current membership — the §2 argument applied to a credential instead of
  a rule.
- **Quota-based rate limiting**, per PLAN.md §627. The existing per-IP/per-account sliding
  windows are the wrong shape for a token that legitimately makes ten thousand calls a day.
- A token is shown once, listable by prefix and last-used, and revocable — `apiToken:revoke`
  already exists for this.

---

## 7. Connectors and import/export (Wave 4)

Slack and GitHub, both OAuth, both storing credentials through
`packages/security/encryption.ts`'s envelope encryption rather than in plaintext columns.
Importers accept CSV/JSON and write **through the service layer**, so an import cannot create
a card that a user could not have created — the same rule §1.3 applies to actions, applied to
a bulk path where it is much more tempting to bypass for speed.

---

## 8. Security notes (the whole phase in five lines)

1. **A rule runs as its owner, re-resolved at execution.** Not as the triggering user, not as
   the system, not as whatever its author's role was on the day they saved it.
2. **Every action is a closed union naming an existing service method.** No scripting, no
   template evaluation, no dynamic dispatch on a user string.
3. **Loop protection is durable and lives in Postgres**, because the in-process version is
   reset by the restart an attacker causes.
4. **Outbound requests reuse `outbound-url.ts`, per hop.** No second SSRF check, no widening.
5. **Cost-bearing actions pass `checkOutboundAllowed`**, the same chokepoint every human-
   initiated call and SMS passes — assuming §9 decision 3 admits them at all.

---

## 9. Decisions — RESOLVED 2026-08-11

Recorded with their reasoning rather than collapsed into the body, so a later reader can see
what was weighed. Two (1 and 3) overturned the draft's own recommendation.

1. **`apps/worker` — RESOLVED: build it, in Wave 1. Overturns the draft.**

   The draft recommended staying on a timer inside `apps/api` because "moving seven working
   loops is a separate refactor." That was a false pairing: **nothing requires the existing
   seven to move in order for new work to run somewhere else.** They stay exactly where they
   are; the worker takes only what this phase and Phase 11 add.

   The load argument also holds up better than the draft credited. The seven existing loops
   are small drains — claim a few rows, write a few rows, sleep. This engine evaluates rules
   against every event, executes actions through the full service layer, and in Wave 2 makes
   outbound HTTP calls with retry and backoff. Node runs all of that on the same thread that
   serves requests, so a slow webhook receiver directly becomes a slow board for a user who
   has nothing to do with that rule.

   What lands in `apps/worker`: the automation engine, webhook delivery, and (Phase 11) the
   analytics rollup refresh. The existing seven can migrate later, one at a time, each with
   its own verification — a follow-up this phase names and does not perform.

   Cost, stated honestly: a fourth Dockerfile, a `compose.prod.yaml` service, a health
   endpoint (`apps/realtime`'s two-tier `/health/live` + `/health/ready` is the pattern), and
   its own env validation. Architecturally low-risk, because `claimPending`'s
   `FOR UPDATE SKIP LOCKED` was built for multiple processes from the start — a second
   consumer process is the case it was designed for, not a new one.

2. **Where depth lives — RESOLVED: an optional `causation` field on the envelope.** Taken on
   the draft's recommendation, not separately argued. `EventEnvelopeSchema` is `.strict()`, so
   the field is additive-optional and old events without it read as depth 0. Depth is a
   property of the EVENT; the alternatives (a side table, or a lookup from the triggering
   event id) both put a join on the hot path of the one loop that must never be slow.

3. **Cost-bearing actions — RESOLVED: IN scope, doubly gated. Overturns the draft.**

   The draft proposed deferring "place call" and "send SMS" entirely, citing Phase 7's history
   of being marked complete through five waves without ever having worked against a real
   carrier. That history is a reason for care, not a reason for absence — the capability is
   genuinely useful (an escalation rule that phones the on-call engineer is the obvious case),
   and deferring it indefinitely just means it gets built later with less thought.

   Two gates instead, and they answer different questions:

   - **`AUTOMATION_TELEPHONY_ACTIONS_ENABLED`**, in the validated env schema, **default
     false.** Deployment-wide: do these actions exist in the builder at all.
   - **A separate automation spend sub-budget** (§5.5), so unattended spend cannot consume the
     allowance a human needs for a real call.

   **Why the env flag does not violate guardrail 7** ("never put a security control behind a
   flag"), stated explicitly because it looks like a violation at a glance: the flag gates
   whether a PRODUCT SURFACE exists — whether the action appears in the rule builder. Every
   security control (`checkOutboundAllowed`'s geo table, org freeze, subaccount status, the
   rolling spend cap, the velocity limiter) runs unconditionally on both sides of the flag,
   through the identical chokepoint every human-initiated call already passes. Turning the
   flag on adds a caller to an existing gate; it does not weaken, bypass or reconfigure the
   gate. Turning it off is defence in depth, not the defence.

4. **Permission tier — RESOLVED: `automation:manage`, `webhook:manage` and
   `integration:manage` join `ORG_LEVEL_PERMISSIONS`.** Taken on the draft's recommendation.
   All three are absent today, which means a relationship tuple can satisfy the route floor —
   a hole if the service does no second resource-aware check. A rule is org furniture with no
   resource for a tuple to point at, so the floor is role-only and §2's per-ACTION check is
   the layer that is resource-aware.

5. **Public API surface — RESOLVED: one API, the existing tRPC router with token auth.**

   A second surface is a second place every authorization decision has to be made correctly
   and kept correct forever, and the drifted copy is always the one without tests — the
   failure mode `apps/collab` had to be explicitly argued into being an exception to.

   What "no way to spoof or misuse it" means concretely, so it is checkable rather than
   aspirational:

   - The token is **hashed at rest** and shown once; `tokens.ts` already returns
     `{ token, hash }` and its header already forbids logging or persisting the plaintext.
   - A token's scopes are a **subset of its owner's permissions, re-resolved per request**
     against the current membership. A demotion weakens every token that person holds,
     immediately — the §2 argument applied to a credential.
   - **A token carries no permissions of its own.** There is no representation for a token
     more powerful than the human who minted it.
   - Every route keeps its `route({ permission })` fail-closed gate. Token auth changes who
     the caller is, never whether the check runs.
   - **Guardrail 8 enrols new routes automatically** from the router manifest, so an API route
     is cross-tenant fuzz-tested against a second org's ids without anyone remembering to add
     it.
   - Quota-based rate limiting (§6), revocable, with prefix and last-used visible.

6. **Partial action failure — RESOLVED: stop, and record which action failed.** Confirmed in
   review. Automatic retry of a partially-applied multi-action rule is how one flaky webhook
   produces four card moves. §3's run history is what makes the stop diagnosable.
7. **Outbox retention — RESOLVED: this phase does NOT prune. Phase 11 does, after its
   backfill.**

   Nothing prunes `platform.outbox` today, and this phase adds a consumer that also WRITES
   events, which compounds the growth. Pruning is correct — and doing it HERE silently
   destroys the only source Phase 11 can reconstruct its history from, because
   `work.cards` stores only the present and the un-pruned outbox is the sole surviving record
   of every `card.status_changed` ever emitted. Nothing would fail. No test would go red. The
   data would simply be gone.

   The ordering constraint, stated identically in both files and in the tracker:

   > **Either Phase 11's backfill runs before any outbox pruning ships, or the pruner must
   > exclude the event names Phase 11 replays until it has.**

   Phase 11 both needs the data and is best placed to replace an accidental event store with
   a deliberate one, so it owns the cleanup. See
   [ai/phase-11-analytics.md](ai/phase-11-analytics.md) §2.4 and its §7 decision 7.

8. **Run-history UI — RESOLVED: two tiers, added in review.** Not in the original draft.

   - **Org tier**: an admin of an org sees that org's rule runs — which rule, which trigger,
     the condition verdict, per-action outcome, the failure. Ordinary org-scoped data, so
     RLS does the isolation and no new mechanism is needed. This is what makes §3's "my rule
     did not fire" answerable by the person asking it.
   - **Platform tier**: a platform operator sees runs across every org, through
     `platformRoute` — no org context, step-up on every call, and every view recorded in the
     global `platform.operator_audit_log`, which already logs READS as well as writes.

   The two are separate surfaces reading separate scopes, never one screen with a filter: an
   org admin must have no way to express "show me another org's runs", and the safest way to
   guarantee that is for their surface to have no vocabulary for it.

9. **Operator/tenant account separation — RESOLVED as a policy plus one small guardrail,
   recorded here because the review surfaced it; the work itself belongs to the platform
   console, not to this phase.** See the addendum in
   [ai/pre-launch-hardening.md](ai/pre-launch-hardening.md).

---

## 10. What is deliberately NOT in this phase

Named so the gaps are decisions, not oversights:

- A scripting language, a formula language, or anything that evaluates a user string as code.
- Bi-directional sync with Slack/GitHub — this phase pushes and receives webhooks; it does not
  reconcile two systems' state.
- **Migrating the seven existing background loops into `apps/worker`.** The worker is built
  here and takes only new work; moving the others is a follow-up done one at a time (§9
  decision 1).
- **Automation TEMPLATES** — a library of pre-built rules. Rules in this phase are built
  entirely by users in the UI: a trigger picked from the event catalog, a condition built in
  the SAME filter builder the board uses (chips or TQL text, shipped in Phase 8 Wave 3), and
  actions chosen from the closed union. A template library is a product feature on top of a
  working engine and wants the engine to exist first.
- Pruning `platform.outbox` (§9 decision 7 — Phase 11 owns it).
