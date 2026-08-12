# Phase 10 — Automation & integrations

Status: **APPROVED 2026-08-11 — WAVES 1–2 SHIPPED 2026-08-11.** All nine open decisions resolved
in review before building. Written 2026-08-11 against `pre-launch-hardening` HEAD, per
`ai/pre-launch-hardening.md` Priority 4 (each remaining priority is its own multi-week phase
and wants its own spec written and approved before implementation). Phase 8 followed this
route and it worked; this is the same route.

**Wave 3 COMPLETE** — all six slices shipped 2026-08-11 (see the §6 status header): the token
store, the mint/list/revoke lifecycle, the full authentication path, the durable per-token
quota, the web UI, and the closing suites.

**Wave 4's cost-bearing telephony slice (§5.5) SHIPPED 2026-08-12** — `call.place` and
`sms.send` as rule actions behind the off-by-default `AUTOMATION_TELEPHONY_ACTIONS_ENABLED`
flag, the automation sub-budget (migration 0055), the worker executor branches, and the
rule-builder + spend-panel UI. See the "Wave 4 — the cost-bearing telephony actions (§5.5)"
header below.

**Wave 4 still open: the connectors (Slack/GitHub) and the CSV/JSON importers/exporters
(§7).** Waves 1–2 are the engine and the webhook delivery path; the wave list below says
exactly what shipped in each.

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

### Wave 2 — COMPLETE, 2026-08-11

Outbound webhooks: the registry, the signing, the delivery loop, and the `call_webhook`
action. Verified: lint + typecheck clean across api/worker/web/db/security; the four new
suites — signing 7, registry service 11, delivery loop 7, grants 6; the affected suites
(api automation 24, tenancy-fuzz + route guardrails 44, worker automation/env 44, web 325);
`migrate:verify` up → down → up; the RLS checker; the guardrail selftest. **Not verified in a
browser** — the standing caveat, and the reason Wave 1 shipped with gaps a single click found.

1. **Migration 0049** — `platform.webhooks`, `platform.webhook_deliveries`, and the
   `taskflow_webhook` claim role, plus the two constraint widenings delivery needs:
   `notifications_kind_valid` gains `webhook.disabled` and `notifications_subject_type_valid`
   gains `webhook`. 0042's `call.missed` kind was in the dev DB but not in the first CHECK
   list — the first apply failed, the database refusing to let code and schema disagree (the
   lesson of 0036 and Phase 6 Wave 3, on schedule). `taskflow_app` holds SELECT+INSERT on
   deliveries and deliberately no UPDATE; the claim role's grants are column-level, and what
   they exclude is the point — it never sees `payload`, nor `platform.webhooks` at all.
2. **The signing primitive** (`packages/security/webhook-signing.ts`) — the mirror of
   `twilio-signature.ts`, computing what WE send rather than verifying what they send:
   `X-TaskFlow-Signature: t=<seconds>,v1=<HMAC-SHA256>` over the EXACT body bytes, the
   timestamp letting a receiver refuse stale signatures, and `secureEqual` on the verify side.
   The secret is a `tf_whs` token minted once, stored envelope-encrypted under a PER-WEBHOOK
   data key bound by AAD to (org, webhook) — the comms.subaccounts recipe — and never
   readable again: no read-back route exists, and the UI shows it exactly once, on create.
3. **The registry service** (`webhook.service.ts`) — org-scoped CRUD floored on
   `webhook:manage` at the route, and an ENQUEUE that enforces `webhook:manage` itself,
   because it is not reached through a route: the §2 rule applied to an action with no HTTP
   boundary. A member who cannot manage webhooks cannot write a rule that calls them.
   Dedupe on `(webhook_id, event_id)` — the at-least-once engine enqueues once — and a
   disabled endpoint refuses the enqueue, so run history records a failed action instead of
   a queued delivery that can never go out.
4. **The delivery loop** (`apps/worker/src/webhooks/delivery.ts`) — the §5 SSRF gate PER
   REDIRECT HOP, the deliberate difference from `fetchUnfurl` (which refuses redirects
   outright): a webhook is a standing instruction, so `redirect: 'manual'` is load-bearing
   and every hop is re-validated and re-resolved. Backoff 30s→8m, dead-letter at 6 attempts,
   auto-disable at 5 consecutive dead deliveries, with a `webhook.disabled` notification to
   the endpoint's creator and a `webhook.auto_disabled` audit event. The claim is a
   conditional UPDATE on `attempts` (the recording-ingest pattern), and the role that decides
   what to deliver never sees the payload, the URL, or the key — those are loaded per org
   under `withOrgScope` afterward.
5. **The suite caught the claim off-by-one the code shipped with.** `claimDue` pushed the
   candidate row with its PRE-increment `attempts`, contradicting its own `ClaimedRow`
   contract — every attempt was judged one behind, so a delivery that had failed six times
   was told to back off forever: dead-lettering and auto-disable could never fire. The
   delivery test's dead-letter case made it visible; the fix is `attempts + 1`, and the
   interface comment now states what the value IS. A test bug hid it for a while: `makeDue`
   was handed the EVENT id (the helper returned the wrong one), so the backoff it "expired"
   never moved — zero rows updated, silently, and the delivery never became due again.
6. **The grants test** (`webhook-grants.test.ts`) asks the database rather than reading the
   migration: the app role really cannot UPDATE a delivery, the claim role really cannot see
   `payload`, and re-enabling really clears the wound.
7. **The UI** — the webhooks management section on `/automations` (the endpoints a rule's
   `call_webhook` action can name, the one-time secret reveal, a delivery-history read), and
   the `call_webhook` action through the five-place change with a real webhook picker — no
   pasted ids anywhere.

**One thing this phase must NOT get wrong, restated at the top because it is invisible from
inside this file:** Phase 11's only route to historical data is replaying `card.status_changed`
out of `platform.outbox`, which nothing has ever pruned. **This phase does not prune it** —
see §9 decision 7 and [ai/phase-11-analytics.md](ai/phase-11-analytics.md) §2.4.

### Wave 4 — the cost-bearing telephony actions (§5.5), COMPLETE (commit `924d539`)

The slice §9 decision 3 put last and behind the flag: `call.place` and `sms.send` as rule
actions, available only when `AUTOMATION_TELEPHONY_ACTIONS_ENABLED` is true — off by default
in BOTH the API's and the worker's validated env schemas, parsed from the literal string
(the `RETENTION_SWEEP_ENABLED` lesson). Migration 0055, the API and worker changes, and the
rule-builder and spend-panel UI shipped together.

Backend:

1. **Migration 0055** — `comms.spend_ledger.kind` gains `automation_call` and `automation_sms`
   (the CHECK widens rather than being replaced; the provider is never asked to price them —
   a call costs what a call costs), and `comms.spend_policy.automation_cap_cents`, the org's
   separate ceiling for unattended spend, with a non-negativity CHECK. NULL means "no separate
   ceiling" — the org cap alone bounds automation, which is the pre-feature behaviour. The
   sub-budget is per-ORG and in the DATABASE for the identical reason `cap_cents` is: policy
   is not a redeploy.
2. **The write boundary is a function of the flag.** `buildAutomationActionSchema` adds the
   two variants only when enabled, so with the flag off a rule containing one cannot be SAVED
   at all — the same error a mistyped action type gets. `to` is validated against
   `PhoneNumberTextSchema` (the plain-string E.164, because a branded output would make the
   exported schema un-nameable for `tsc --declaration`; the executor re-brands at the
   boundary). `record` is deliberately absent: an unattended rule must never be able to start
   recording a person. `automation.capabilities` answers the flag to the builder through the
   real router, so the UI never hard-codes a copy of the deployment env.
3. **The actions are NOT a second gate.** `placeCall`/`sendSms` take an
   `{ initiatedBy: 'automation' }` option that changes ONLY the kind the gate sees and the
   ledger records — the same `checkOutboundAllowed` chain (geo table, org freeze, subaccount
   status, rolling cap, velocity limiter) runs identically, and the velocity table gives the
   automation kinds their OWN per-owner buckets so a rule cannot drain the allowance a human
   needs for a real call. The sub-budget is summed over the automation kinds in the SAME
   window as the org cap and checked IN ADDITION to it, never instead of it; a refusal cites
   the sub-budget's own figures, so an operator alerting on `automation_budget_exceeded` is
   not woken by a plain overspend.
4. **The executor** runs the actions through the same service functions a human's call uses —
   `record: false` always — and `telephonyFor` refuses loudly, as a recorded failed action,
   when the flag is off (a rule saved under an earlier configuration) or when no carrier is
   configured. Loop protection lists `call.placed`/`call.status_changed` for `call.place` and
   `sms.sent` for `sms.send`, conservatively per the table's own header.
5. **One construction, two processes.** `buildTelephonyDeps` now takes a structural
   `TelephonyEnv` subset, so the worker builds the identical provider selection, spend
   defaults and boot validations (including `TELEPHONY_WEBHOOK_ORIGIN` being required for a
   live carrier) from the same function the API uses.

Web:

6. **The rule builder** offers the two actions only when `automation.capabilities` says the
   flag is on (`offeredActions`, false until the answer arrives — the safe side). The `To`
   field is a `phoneTarget` picker: the org's members with a work phone offered as prefilled
   options (the same `phoneContactsQuery` click-to-call uses), plus a "Custom number…"
   fall-through to a typed E.164 for anyone not in the directory; the server validates.
   `From (your number)` is a `phoneNumber` picker over the org's OWN numbers, because the
   service resolves the id under `withOrgScope` and a number the org does not hold is a 404.
   A rule saved while the flag was on stays visible and editable after it is turned off —
   the server refuses to save it unchanged with a real message rather than the UI swapping
   the action for whatever sorts first.
7. **The spend panel** shows an "Automation allowance" bar (the same figures
   `checkOutboundAllowed` enforces against) when the org has configured a sub-budget, and the
   cost-attribution table labels the automation kinds instead of printing `automation_call`
   raw.

Verified: lint + typecheck clean across web/api/worker/db; web 341/341 (including the
11-test `vocabulary.test.ts`); the API automation + telephony suites 56/56; the worker
executor 7/7. The full `pnpm verify` had not completed when this slice was committed — the
turbo run exceeds an agent's per-command cap, not because anything failed; the remaining
package suites (db, seed, realtime, collab, telephony) are in the commit's status note.
**Browser verification was in progress when this slice was committed** — the standing
caveat, and the reason Wave 1 shipped with gaps a single click found.

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
  router with token auth. **Fully spec'd in §6, 2026-08-11 — not built.**
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

**SLICES 1–6 SHIPPED 2026-08-11 — Wave 3 COMPLETE.** The token store, the
mint/list/revoke lifecycle, the full authentication path, the durable per-token daily
quota, the web UI, and the remaining suites that closed the wave.

1. **Slice 1 — migration 0050** `platform.api_tokens` + the `taskflow_api_token_auth` role
   (the twelfth; column-level SELECT of `token_hash, org_id, created_by, scopes, revoked_at`,
   never `name`/`token_prefix`/`last_used_at`, no writes) + `resolveApiToken`. Soft-delete
   only: `REVOKE DELETE` from `taskflow_app`, the 0036 lesson. No scopes CHECK on purpose —
   the catalog lives in TypeScript and a bogus scope is inert, since enforcement is the
   intersection with live `can()`.
2. **Slice 2 — mint/list/revoke.** Mint validates every scope against the minting user's
   LIVE `can()` with no target — role alone, deliberately: a token authenticates org-wide,
   so a tuple-granted per-resource capability must not become an org-wide claim. The token
   is stored as `sha256` and returned in plaintext exactly once; `list` never exposes the
   hash; revoke is a conditional UPDATE so two concurrent revokes emit exactly one
   `api_token.revoked` event. Mint and revoke are `stepUp: true` — §6.4's "a script must
   not mint more tokens" hook, which slice 3's builder gate now enforces.
3. **Slice 3 — the authentication path.** `authenticateWithApiToken` in
   `apps/api/src/identity` ⚠ §2.2: bearer parse → `tf_pat` kind check → hash →
   `resolveApiToken` (revoked/unknown is null, no courtesy window) → org from the TOKEN
   with a disagreeing header refused (decision 11) → membership re-resolved live →
   `tokenScopes` on the principal. The builder gate intersects `permission ∈ tokenScopes`
   and refuses token principals on `selfRoute`/`publicRoute`/`stepUp` routes. Migration 0051
   widened the auth role's grant with `id, created_at` so `sessionId`/`authenticatedAt` can
   name the token row.
4. **Slice 4 — the quota.** Migration 0052 `platform.api_token_quota`, one row per token
   with TWO counters — `used_count` (every request) and `expensive_count` (the closed class)
   — plus `quota_date` (the UTC day). The consume is a single upsert whose ceilings live in
   the `ON CONFLICT ... WHERE` (the claim pattern), with the day-boundary rollover in the
   same statement's CASEs: a stale `quota_date` resets both counters instead of refusing,
   atomically. `quotaClass: 'expensive'` rides in route meta, is manifest-visible, and is
   carried by search's `query`, docs' `exportPdf`, and telephony's `spend.report` +
   `recordings.download`. A refusal is `QUOTA_EXCEEDED` (429) with `retryAfterSeconds` to
   midnight UTC. Limits are TS constants (`100_000` daily, `2_000` expensive) — deployment
   policy, not schema.
5. **Slice 4 review — migration 0053.** Two findings landed. The first is the drift this
   header records rather than papering over: 0050 created `platform.api_tokens.last_used_at`
   and documented it as the quota path's throttled write, and slice 4 first put a SECOND
   `last_used_at` on the quota row — two columns for one fact, and the list view would have
   had to join to see it. 0053 drops the quota column; the consume's once-per-minute write
   targets `api_tokens.last_used_at` in the same transaction as the upsert. The second is a
   one-line off-by-one in the rollover CASE: a day that began with a NORMAL request's
   rollover started `expensive_count` at 1 (the fresh-INSERT path writes 0), quietly
   shrinking the expensive allowance by one for that day — the CASE now writes
   `expensive ? 1 : 0`, the same values the INSERT does.
6. **Slice 5 — the web UI.** A third tab on `/automations` beside Webhooks: the list
   (name, `tf_pat_` prefix, scopes, relative last-used, revoked badge), a create form whose
   scope checklist is built from a NEW `apiToken.heldScopes` route — the caller's holdings
   answered by the same role-alone `can()` the mint route validates with, so the form can
   never offer a scope the server will refuse — and the webhook's `SecretReveal` reused for
   the one-time token reveal (extracted to `components/secret-reveal.tsx` so the two
   surfaces share it). The checklist defaults to NOTHING selected; revoke is the same
   two-click `ConfirmButton` discipline as webhook deletion. `SecretReveal` also gained a
   neutral wording — it now says "secret for …" rather than webhook-specific language.
7. **Slice 6 — the remaining suites.** Three layers, each proving something the one
   before could not. (a) The real automation router with a token principal (in
   `api-token-auth.test.ts`): a `webhook:manage` token lists and creates webhooks through
   the actual routes, does NOT bleed into `automation:manage` (rules) — sibling org-level
   permissions stay disjoint — and a webhook created by org A's token is invisible to org
   B's, RLS through the real router. (b) The grants matrix (`api-token-grants.test.ts`):
   the app role is RLS-CONFINED where the lookup role deliberately is not — under org A's
   scope, `taskflow_app` sees only org A's `api_tokens` and `api_token_quota` rows, the
   complement of the auth role's cross-org `USING (true)` lookup. (c) A real HTTP round
   trip (`api-token-e2e.test.ts`, booting `buildServer`): register → verify → login →
   create an org → mint (a step-up route, passed by the fresh session) → drive
   `automation.webhooks.create`/`list` with the token and NO org header → a `card:read`
   token refused 403 → a disagreeing org header refused 401 → the quota counter moved
   (a durable row) → revoke through the session → the credential dead on the next
   request.

**One finding from the slice-3 review that is worth stating out loud:** a suspended org's
request originally THREW `ORG_SUSPENDED` out of `authenticateWithApiToken`, and the unit test
asserted the throw. That would have answered **HTTP 500** in production: an AppError escaping
`createContext` is converted by the tRPC adapter's `getTRPCErrorFromUnknown` into
INTERNAL_SERVER_ERROR, because the `mapErrors` middleware that maps AppErrors to their proper
codes only wraps procedures, never the context builder. The JWT path already swallows the same
throw inside `withOrgContext` and lets the route answer NOT_A_MEMBER. The token path now
swallows it to null too — a refusal, like every other invalid credential, never a server
error. The test asserts `resolves.toBeNull()` with the reasoning in the comment.

**Slice 4's own suite caught a real bug in the first version of the throttle:** the
`last_used_at` CASE lived in the `DO UPDATE`, which only runs on conflict — so the FIRST
request of a token's life (a pure INSERT) left the column NULL until a second request. The
review's 0053 moved the column entirely; the bug is moot. The day-boundary assertion also
survived two wrong versions before landing on `quota_date::text` in the test read:
node-postgres parses a `date` column as LOCAL midnight, and `toISOString()` on that shifts
the day back by the UTC offset — the rollover was working, the assertion was reading it
through a timezone.

**The slice-6 HTTP round trip caught a real bug in `server.ts`'s dispatch — the one
layer every prior test bypassed.** `authenticateRequest` decided the token path with
`authorization.trim().startsWith('tf_pat_')`, and `"Bearer tf_pat_…"` starts with
`Bearer`, not `tf_pat_` — so the condition was ALWAYS false and every token request fell
through to the JWT path and answered UNAUTHENTICATED. The slice-3 suite called
`authenticateWithApiToken` directly, which bypasses this dispatch entirely; the builder
gate fed a pre-built principal. Nothing short of a real HTTP request could see it — the
same lesson Phase 7 learned from a live carrier, and exactly what the E2E is for. The fix
parses the bearer with the same `bearerToken` both auth paths use and dispatches on the
body (`bearer?.startsWith('tf_pat_') === true`), matching the comment that was already
there: the misroute lands in the token path, where `isTokenKind` refuses anything not
genuinely a `tf_pat`, fail-closed.

Verified: api/db/realtime/collab typecheck + lint clean; the auth suite 22/22 (the
slice-3 set, the five quota tests, and slice 6's four real-router webhook tests); the
HTTP E2E 1/1 (the full round trip above); service 11/11; grants 12/12 (0052's REVOKE
DELETE, the auth-role column matrix, and slice 6's two app-role RLS-confinement tests);
route manifest + fuzz 82/82; guardrail selftest; the RLS checker; `migrate:verify` up →
down → up. **Not verified in a browser** — slice 5 is the UI.

### 6.1 The token

- `tf_pat` (`apiToken` in `tokens.ts`), 256 bits of CSPRNG output, **hashed at rest** —
  `issueToken` returns `{ token, hash }` and its header already forbids logging, persisting
  or auditing the plaintext. The token exists in plaintext exactly once, in the response
  that mints it.
- The row stores `token_hash` (the lookup key), `token_prefix` (the first ten characters of
  the body, stored at mint for the list view — a partial that is useless to whoever reads
  the table, the same deal `describeAction`'s truncated ids make), the minting user, the
  org, the scopes, and revocation state.
- **A token is shown once.** No read-back route, and no rotation in this wave — a lost token
  is a revoked token and a fresh mint, the same deal the webhook secret makes.
- Revocation is a soft delete (`revoked_at`): the audit trail keeps the row, the auth lookup
  refuses it. `apiToken:revoke` already exists in the catalog and the matrix (owner/admin)
  and `decide.test.ts` already proves no relationship tuple can satisfy it.

### 6.2 The table, the role, and the lookup

- **Migration 0050** — `platform.api_tokens`, org-scoped and RLS-FORCED like every tenant
  table, with org-scoped policies for `taskflow_app` (SELECT/INSERT/UPDATE; no DELETE —
  revoke is the operation). The `scopes` column gets NO CHECK constraint, deliberately: a
  bogus scope is inert (enforcement is the intersection of the token's scopes and the live
  `can()` answer, so a stored scope no one can hold matches nothing), the catalog lives in
  TypeScript where every permission addition would otherwise demand a migration, and the
  write boundary is the route's Zod schema — the same place automation action types close.
- **The auth lookup is a cross-org read, and gets the claim-role treatment, not the
  directory treatment.** The inbound-webhook precedent (`comms-directory.ts`) reads a table
  with NO RLS — safe because it carries only a SID and an org id. The token table cannot
  do that: scopes and revocation ARE the security state, and a no-RLS copy would drift the
  instant anything else touched it — a revoked token that still authenticates is the exact
  failure a sidecar table makes possible. So the lookup runs as a NEW narrow role
  (`taskflow_api_token_auth`, the twelfth), with column-level SELECT of exactly
  `(token_hash, org_id, created_by, scopes, revoked_at)` — never `name`, `token_prefix` or
  `last_used_at` — and a `FOR SELECT USING (true)` policy, the recording-ingest recipe
  applied to the authentication path. **The role that decides who you are cannot read what
  your tokens are called or when you last used them.**
- The helper lives in `packages/db` (`api-tokens.ts`): `resolveApiToken(hash)` →
  `{ orgId, userId, scopes } | undefined`, `WHERE token_hash = $1 AND revoked_at IS NULL`,
  the same "one query with no org yet, readable in one sitting" argument as
  `comms-directory.ts`. Revocation takes effect on the next request — the lookup carries
  no cache to outlive it.

### 6.3 Minting — scopes are a subset, checked twice

- The mint route is floored on `apiToken:create`. Who holds that permission is the shipped
  matrix — owner/admin — and widening it is §9 decision 10.
- Every requested scope is validated against the minting user's LIVE `can()`: a scope the
  user does not currently hold is refused at the form. That is the "subset, never a
  superset" rule at mint time. It is re-checked at REQUEST time (§6.4) because membership
  changes: a demotion weakens every token the person holds, immediately.
- Scopes are permission strings from the closed catalog, chosen by checkbox in the UI from
  what the caller can currently do — no free text, the same "a rule is data, never a
  script" discipline applied to credentials.

### 6.4 The authentication path

- `authenticateWithApiToken(header)` in `apps/api/src/identity` — ⚠ HUMAN REVIEW SURFACE
  (§2.2): the second function that decides who a request is, and it gets the same
  read-every-line treatment as `authenticate`:
  1. `bearerToken` parse; refuse anything not `tf_pat`-prefixed (the kind is part of the
     contract — `isTokenKind`);
  2. hash the presented token, `resolveApiToken` by hash — revoked, disabled, or unknown
     is `null`, so the request is UNAUTHENTICATED and fail-closed routes refuse it. The
     "stale credential may still call auth.login" courtesy JWT has does not extend here: a
     token either resolves or it does not;
  3. **the org comes from the TOKEN, never from the `x-taskflow-org` header.** A token
     minted for org A must not be steerable at org B by sending a header — the header is
     attacker-controlled — and a token request whose header disagrees with the token's org
     is REFUSED rather than ignored, so a script that copied a browser's header fails
     loudly instead of quietly doing nothing (decision 11);
  4. the membership is resolved (`withUserScope`) exactly as a JWT request resolves it:
     role + tuples, live. No longer a member → null → unauthenticated. Org suspended →
     `resolveOrgMembership` already refuses it. **A token does not outlive its holder's
     membership** — the demotion guarantee stated as an identity fact;
  5. the principal carries `tokenScopes` (the row's scope set) beside the usual fields;
     `sessionId` is the token's row id so audit entries have something joinable, and
     `authenticatedAt` is the token's `created_at` — the token IS the credential.
- **The route gate intersects.** `route({ permission })` runs its `can()` check as always —
  token auth changes who the caller is, never whether the fail-closed check runs (decision
  5's sentence) — and a token-authenticated principal is additionally refused when
  `permission ∉ tokenScopes`. A token scoped to `card:read` is refused on `card:update`
  routes even while its owner could do both.
- **Tokens cannot satisfy self, public, or step-up routes.** A token principal on a
  `selfRoute`, `publicRoute`, or `stepUp: true` route is FORBIDDEN in the builder — a
  long-lived credential is not re-authentication, and a script must not be able to revoke
  sessions or mint more tokens with a credential no browser ceremony protected. A builder
  assertion, manifest-visible like the access kinds.

### 6.5 Quota — durable, per token, per day (PLAN.md §627)

- Every token request counts toward the token's daily total (generous default — the point
  of a token is programmatic volume), and a CLOSED CLASS of expensive routes (PLAN.md §627
  names search, analytics, export, telephony) counts additionally against a tighter
  per-token daily quota. A route opts into the class by declaring `quotaClass` in its meta
  — manifest-visible, like every other route property.
- The counter is a row in Postgres (`platform.api_token_quota`), not an in-process window:
  a restart must not forgive a quota, the same argument the automation budget and the TURN
  issuance ledger make. Consuming is a conditional UPDATE (`WHERE used < quota`), the
  claim pattern — two parallel requests cannot both pass a one-slot quota.
- `last_used_at` is written on the same row, throttled to once per minute per token (a
  minute-level guard in the UPDATE's WHERE) — the list view's "last used" without a write
  on every request. The per-IP and per-account windows stay in front of everything; the
  quota is the token's own allowance on top (decision 12).

### 6.6 The routes, the UI, and the tests

- Routes: `apiToken.create` (mint — returns the token exactly once), `apiToken.list`
  (name, prefix, scopes, last-used, revoked), `apiToken.revoke`. All floored on their
  matrix permission.
- UI: an "API tokens" section on `/automations` beside webhooks — the same developer
  surface, since that page already holds the org's programmatic endpoints. Create is a name
  plus a scope checkbox list built from the caller's live `can()`; the one-time secret
  reveal is the webhook's `SecretReveal` reused. A dedicated developer page waits for Wave
  4's connectors, which are the same audience.
- Events: `apiToken.created`, `apiToken.revoked` — typed domain events through the outbox
  like every other mutation, so audit and notifications get the fact for free.
- Guardrail 8 enrols the new routes automatically from the manifest — cross-tenant fuzz
  against a second org's ids, no remembering to add them.
- The suites: mint/list/revoke service tests; the auth path against real Postgres (valid
  token, wrong kind, revoked, unknown, deleted user, org-suspended, header mismatch);
  scope enforcement (a `card:read`-scoped token refused on `card:update`; a demotion
  weakening an existing token IMMEDIATELY — mint with `audit:read` as admin, demote to
  member, the token now fails); quota (exhaust → refused; the counter survives a
  reconnect); grants (the auth role really cannot read `name`, `token_prefix` or
  `last_used_at`); the matrix (a member cannot mint).

### 6.7 Wave slices

1. Migration 0050 + the `taskflow_api_token_auth` role + schema + the `packages/db` lookup
   helper.
2. The token service + routes: scope validation against live `can()`, the events, the
   minted-once contract.
3. The authentication path and the builder gate: token principal, org from token + header
   refusal, scope ∩ `can()`, self/step-up refusal.
4. Quota: the table, the consume helper, `quotaClass` wiring.
5. The UI section.
6. The test suites named in §6.6, plus the grants test and the fuzz enrolment.

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

10. **Who may mint tokens — RESOLVED: owner/admin, the matrix as shipped. (Wave 3, §6.3.)**

    The draft considered widening `apiToken:create` to members — a member's token is capped
    at their own permissions by the subset rule, so the security argument is already
    settled either way. The resolution is the standing-credential argument instead: a token
    is org furniture, like a webhook or an automation, and the org's owners decide who may
    mint and revoke them. Widening later is a one-line matrix change plus a UI label; the
    decision is recorded so that later edit knows it is a product call, not an oversight.

11. **A disagreeing `x-taskflow-org` header — RESOLVED: refused, not ignored. (Wave 3,
    §6.4.)**

    Ignoring is friendlier — a script that copied a browser's header still works. But
    "your token is for org A and you asked for org B" is either a bug in the script or an
    attempt to steer a credential; both deserve a loud refusal, and a quiet no-op that
    reads as success is how a token ends up minted for the wrong org and discovered a
    year later. The header must be absent or equal to the token's org.

12. **Quota shape — RESOLVED: a durable per-token daily total plus a closed expensive
    class with tighter caps. (Wave 3, §6.5.)**

    Counting only the expensive endpoints would leave the rest of the API unquotated
    against a stolen token; counting only a total would make "search is expensive"
    unenforceable. Both counters live in Postgres (a restart must not forgive a quota),
    both consume via the conditional-UPDATE claim pattern, and the per-IP/per-account
    sliding windows stay in front of both — a token gets a generous allowance on top of
    them, never an exemption from them.

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
