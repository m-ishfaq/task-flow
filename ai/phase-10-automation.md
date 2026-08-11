# Phase 10 — Automation & integrations

Status: **DRAFT — not yet approved.** Written 2026-08-11 against `pre-launch-hardening` HEAD,
per `ai/pre-launch-hardening.md` Priority 4 (each remaining priority is its own multi-week
phase and wants its own spec written and approved before implementation). Phase 8 followed
this route and it worked; this is the same route.

Scope is PLAN.md §13's Phase 10 row and §10.3: a cross-product rules engine with loop
protection and run history, outbound webhooks, a public API with scoped tokens, Slack/GitHub
connectors, and importers/exporters.

Read this header before trusting a status marker anywhere else in this file — the standing
lesson every `ai/phase-*.md` in this repo states for itself, and the one Phase 8's Wave 3 had
to learn the hard way six commits ago.

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
  satisfy `apiToken:create`. The first three are deliberately NOT in that list, which is a
  decision this phase inherits and must either use or argue with (§9, decision 4).
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
  §9 decision 1 is whether this phase changes that.
- **No `platform.automations`, `automation_runs`, `webhooks` or `integrations` tables.**
  PLAN.md §365 lists them in the `platform` schema; the schema today has `outbox`,
  `outbox_dispatch`, `notifications`, `notification_deliveries`, `notification_prefs`,
  `push_subscriptions`, `attachments`, `operators`, `flag_overrides`, `operator_audit_log`,
  `socket_io_attachments`. The four this phase needs are unbuilt.
- **The envelope has no causation or depth field**, and `EventEnvelopeSchema` is `.strict()`.
  Loop protection has to put depth SOMEWHERE, and that is §9 decision 2.
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

- **Wave 1 — the engine.** `platform.automations` + `platform.automation_runs`, the fifth
  outbox consumer, trigger matching, conditions through the existing evaluator, and the
  three loop-protection layers (§4). Actions limited to the ones with no external effect and
  no cost: move card, set field, assign, add label, create/update doc page, post chat message,
  send notification. Run history and a kill switch ship in this wave, not later.
- **Wave 2 — outbound webhooks.** `platform.webhooks`, HMAC signing with the existing
  `tf_whs` prefix, delivery attempts with backoff and a dead-letter state, and the SSRF gate
  applied per redirect hop. This is the first action that reaches a network the org does not
  control.
- **Wave 3 — the public API and scoped tokens.** `tf_pat` tokens with per-token scopes, a
  quota-based rate limit (PLAN.md §627 names analytics/search/export/telephony as the
  quota tier), and the REST/tRPC surface question in §9 decision 5.
- **Wave 4 — connectors and import/export.** Slack and GitHub as the two named integrations,
  plus CSV/JSON importers and exporters. Everything here is built on Waves 2–3's primitives;
  a connector is a webhook with a known shape and an OAuth credential.

Cost-bearing actions (place call, send SMS) are **not** in any wave above and are §9
decision 3.

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
  §9 decision 6 is whether a partial failure retries.

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
slices. §9 decision 2 is where it does live.

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

## 9. Open decisions for approval

1. **`apps/worker`.** Build it in Wave 1 and move the automation engine (and possibly the
   other seven loops) into it, or keep `setInterval` inside `apps/api` like every existing
   consumer? _Recommendation: keep it in `apps/api` for this phase._ Moving seven working
   loops is a separate refactor with its own failure modes, and the engine is a fifth consumer
   of a pattern that demonstrably works. Naming it a follow-up is honest; bundling it here
   doubles the phase's blast radius.
2. **Where depth lives.** Three options: (a) an optional `causation` field added to the
   envelope (`.strict()` schema, so additive-optional is safe, but it changes a type every
   slice shares); (b) a separate `platform.event_causation` table keyed on event id; (c) a
   dispatch-time column on `automation_runs` plus a lookup from triggering event id.
   _Recommendation: (a)._ Depth is a property of the EVENT, every consumer benefits from
   seeing it, and (b)/(c) both require a join on the hot path of the one loop that must never
   be slow.
3. **Cost-bearing actions (place call, send SMS).** In scope behind `checkOutboundAllowed`, or
   deferred entirely? _Recommendation: defer to a follow-up._ Phase 7's own history is that
   outbound telephony was "complete" through five waves and had never worked against a real
   carrier; making it fire unattended, from a rule, is not where that capability should get
   its next exercise.
4. **Do `automation:manage` / `webhook:manage` / `integration:manage` become org-level?**
   They are absent from `ORG_LEVEL_PERMISSIONS` today, which means a relationship tuple can
   satisfy the route floor. If the service does no second per-resource check, that is a hole.
   _Recommendation: add all three to `ORG_LEVEL_PERMISSIONS`_ — a rule is org furniture with
   no resource for a tuple to point at — and let the per-ACTION check of §2 be the layer that
   is resource-aware.
5. **Public API surface.** Expose the existing tRPC router with token auth, or write a
   separate REST surface? _Recommendation: tRPC with token auth for this phase._ A second
   surface is a second place every authorization decision must be re-made, which is the
   failure mode `apps/collab` had to be argued into being an exception to.
6. **Partial action failure.** Retry the whole rule (re-running succeeded actions, so actions
   must be idempotent), retry only the failed action, or fail the run and stop?
   _Recommendation: fail the run and stop, recording which action failed._ Automatic retry of
   a partially-applied multi-action rule is how one flaky webhook produces four card moves.
7. **Outbox retention — and this one is not independent of Phase 11.** Nothing prunes
   `platform.outbox` today. This phase adds a consumer that also WRITES events, which compounds
   it. Prune here, or name it as separate work?

   **Before answering, read [ai/phase-11-analytics.md](ai/phase-11-analytics.md) §2.4.** That
   phase has no status-transition history to work from — `work.cards` stores only the present —
   and its ONLY route to a backfill is replaying `card.status_changed` out of the un-pruned
   outbox. Pruning is correct and it silently destroys the one source Phase 11 can reconstruct
   its history from, with nothing failing to say so.

   The ordering constraint, stated identically in both files:

   > **Either Phase 11's backfill runs before any outbox pruning ships, or the pruner must
   > exclude the event names Phase 11 replays until it has.**

   _Recommendation: name it here, implement it in Phase 11_, which is the phase that both
   needs the data and is best placed to replace an accidental event store with a deliberate
   one. Doing it here, first, is the version that loses the history.

---

## 10. What is deliberately NOT in this phase

Named so the gaps are decisions, not oversights:

- Cost-bearing automation actions (§9 decision 3).
- A scripting language, a formula language, or anything that evaluates a user string as code.
- Bi-directional sync with Slack/GitHub — this phase pushes and receives webhooks; it does not
  reconcile two systems' state.
- `apps/worker` (§9 decision 1).
- Automation TEMPLATES (a library of pre-built rules), which is a product feature on top of a
  working engine and wants the engine to exist first.
