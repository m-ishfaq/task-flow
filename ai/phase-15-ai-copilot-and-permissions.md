# Phase 15 — Org-Level Permission Grants & AI Copilot

**Status: §1 (org-level permission grants) SHIPPED and extended past this draft's own scope; §2+§3
(the `AiProvider` abstraction and the token/spend budget gate) have SHIPPED, per §10's own build
order; §4 Wave 1 (the tool-calling assistant, read-only tools: `search`) has SHIPPED; §4's write
tools and confirm-before-execute, plus §5–§8 (the standup view, the doc-space bootstrap, GitHub/PR
review, onboarding/offboarding automation) remain DRAFT — not yet approved for build, and nothing
in those sections has been implemented.** Written up per this repo's own convention (see
CLAUDE.md's running note that "a status marker is a claim, not a fact") so that build order and
scope are agreed before code, not discovered after — left corrected in place here rather than
silently rewritten, per that same convention, each time a wave shipped without this header being
updated first.

**What §1 actually shipped, past what this draft asked for:** the `authz.member_grants` mechanism,
`can()` composing role + tuple + grant, and the telephony five (`phoneNumber:read`, `call:place`,
`call:read`, `sms:send`, `sms:read`) becoming individually grantable — closing the §0.3 gap this
phase exists to fix. Then, in a follow-up pass this same header failed to record until now: a
second wave made `automation:manage`, `webhook:manage`, `integration:manage`, `apiToken:create`,
and `apiToken:revoke` individually grantable too (`GRANTABLE_PERMISSIONS` now holds ten entries,
not five); a full sweep across `apps/web` and `apps/mobile` found and fixed every remaining place a
permission-gated control rendered unconditionally and let the click answer FORBIDDEN, rather than
hiding (or, for the People page specifically, presenting read-only) the control a caller could
never use; the one-member-one-permission add form in `settings-page.tsx` became a bulk multi-select
grant AND revoke UI on both platforms; and `apps/mobile` gained a full Individual Permissions
screen (`permissions.tsx`) where none existed before. None of that — Wave 2's permission set, the
sweep, the bulk UI, or mobile parity — is described anywhere above in §1.1–§1.4; this status line is
the only place that says so until §1 itself is rewritten to match.

**§2 (the AI provider abstraction) and §3 (the token/spend ledger and budget gate) have shipped**
— `packages/ai` (`AiProvider`, `FakeAiProvider`, `AnthropicProvider`), the `ai:use` permission
(`packages/policy`, grantable per §2.4), the `aiAssistant` feature flag, migrations 0099–0100
(`ai.usage_ledger`, `platform.ai_provider_config`, `platform.ai_org_overrides`, and
`ai_token_budget_monthly_cents` on both `billing.plans` and `billing.org_entitlements`),
`apps/api/src/ai` (the budget gate, `completeGated`, the provider resolver, the platform-admin
CRUD service and cross-org spend report), and a new `ai` sub-router on `platformAdmin`. See
CLAUDE.md's own "Phase 15 §2+§3" section for the design corrections made along the way — most
notably that the ledger lives in a new tenant-scoped `ai` schema rather than `platform.*` as
this draft originally said, and that the budget ceiling is resolved through Phase 12 Wave 4's
existing entitlement chain rather than a new override table.

**§4 Wave 1 — the tool-calling assistant, read-only — has shipped.** `apps/api/src/ai/assistant.ts`
(the tool-calling loop, bounded at `MAX_TOOL_ITERATIONS`), `apps/api/src/ai/tools/` (the closed
registry; `search` is the one tool so far, wrapping `performSearch`, freshly extracted out of
`search/router.ts` so the tRPC route and the assistant call the identical authorized pipeline), and
`ai.chat.send` (gated on `ai:use` + `aiAssistant`, per §2.4). `completeGated` (§3) has its first
real caller. `AiMessage` (§2) needed a real fix before this could work at all: the type shipped as
a flat `{ role, content }`, which cannot hold a multi-turn tool-calling exchange — Anthropic's API
rejects a `tool_use` block with no matching `tool_result` in the very next turn. It is now a
discriminated union carrying `toolCalls`/`toolCallId`, and `AnthropicProvider` maps each variant to
the real content-block wire shape. See CLAUDE.md's own "Phase 15 §4 Wave 1" section for the rest —
the loop's bounding, the sequential (not parallel) tool execution, and how a tool's thrown error
becomes a `tool_result` the model reads rather than a crash.

**§4's write tools and confirm-before-execute (§4.2), §5 (the standup view), §6 (the doc-space
bootstrap), §7 (GitHub/PR review), and §8 (onboarding/offboarding automation) remain exactly as
drafted below: designed, not built.** None of §5's standup screen or §7's PR review/merge tools
have any code behind them yet. This spec intentionally covers several waves under one phase number
because they share one foundation (§1) and were scoped together in one planning conversation —
later waves may be split into their own `ai/phase-1N-*.md` files once build starts, the way
Phase 12's waves eventually got their own sections.

⚠ **This phase touches four surfaces CLAUDE.md already requires human review for** —
`packages/policy` (§1), any webhook signature verification (§4.3), and it adds a fifth:
`packages/ai`, because it is the one place org data (card text, chat messages, transcripts) is
allowed to leave the process to a third-party model provider. §2 and §3 have shipped without that
second pass having happened yet — this remains an open item for whoever reviews this diff. Each
wave below names exactly what needs a second pass before merge.

---

## 0. Why this phase exists

Four separate conversations converged on the same missing piece:

1. **An AI assistant** that can create/prioritize cards, plan sprints, and hold a conversation with
   whoever is chatting — needs a way to say "only these specific people may use this," not just
   "everyone with the Member role."
2. **PR review from inside TaskFlow** — same shape: "only the team lead I pick may review/merge,"
   not a whole role.
3. **Telephony, audited for this phase, turned out to already have the identical gap in
   production**: any Member can already place calls and send SMS today (`call:place`, `sms:send`
   are on the Member role — `packages/policy/src/roles.ts:141-146`) with **no per-person
   restriction at all** — any member can use any of the org's numbers. This was found while
   researching this phase, not caused by it, and is the clearest evidence the gap is real, not
   hypothetical.
4. **A finer permission model was requested independently** ("PM vs. Product vs. Team Lead should
   each unlock different things") — the same mechanism, again.

So the phase opens with one foundational piece (§1) that everything else is built on top of,
rather than four bespoke access-control hacks.

**Explicitly out of scope for this phase** (raised in planning, deliberately deferred — see §7):
in-house email/mail client, self-hosted/"our own" LLM, transcription for in-app WebRTC calls,
meeting-transcript-to-card automation, and an externally-facing MCP server. None of these are
rejected — they just don't block anything below and are cheaper to scope once the foundation
exists.

---

## 1. Foundation — org-level permission grants

### 1.1 What exists today (confirmed by reading the code, not assumed)

- Four roles: `owner`, `admin`, `member`, `guest` (`packages/policy/src/roles.ts:13`). Owner holds
  the full 60-permission catalog; Admin and Member are each an explicit hand-written list, not
  "role plus extras" (`roles.ts:26-148`); Guest holds nothing from its role at all (`roles.ts:158`).
- A **resource-scoped** per-person grant already exists: relationship tuples
  (`packages/policy/src/tuples.ts`) — `(subject, relation, object)` rows with relations `owner,
editor, commenter, viewer, member` (`tuples.ts:19`). This is how one person can get
  `comment:create` on one specific board without their role changing. It only ever points at a
  resource a tuple type is registered for (board, channel, page, etc.).
- **What does not exist**: granting one **org-level** permission (no resource attached — e.g.
  `call:place`, `ai:use`, `pr:review`) to one specific person without changing their whole role.
  `packages/policy/src/permissions.ts:224-272` explicitly excludes org-level permissions from
  tuple resolution — this is a deliberate boundary in the existing design, not an oversight, and
  this phase does not remove it. It adds a **second, parallel** mechanism for org-level
  permissions specifically, rather than stretching tuples to cover a shape they were not built for.
- The only per-member admin UI lever today is a whole-role dropdown
  (`apps/web/src/features/admin/settings-page.tsx:184-193`). There is a read-only decision-trace
  debugger (`permission-debug-page.tsx`) but nothing to grant/revoke a single permission.

### 1.2 What this wave adds

A new concept, **member grants** — deliberately not folded into the tuple system, so as not to
teach `nearestApplicable()` a second, resource-less code path:

- New table, `tenancy.member_grants` (org_id, membership_id, permission, granted_by,
  granted_at, revoked_at nullable) — RLS-scoped like every other table, through `withOrgScope`.
  `revoked_at` rather than deleting the row, so a revoked grant is still visible in history —
  mirrors how `identity.sessions` and `comms.suppressions` keep history instead of deleting.
- `can()` gains one more source to check, alongside role and tuples: does an active,
  non-revoked `member_grants` row exist for `(membership_id, permission)`? A grant only ever
  **adds** capability — it cannot be used to restrict what a role already grants (removing a
  capability from a role, e.g. "this specific Member should NOT have `call:place`," is a
  different, harder problem — narrowing — explicitly deferred to a later wave rather than
  smuggled into this one; see §7).
- Grants are restricted to a **closed list** of permissions eligible for member-grant assignment —
  not the whole 60-permission catalog. Some permissions (e.g. `org:update`, ownership transfer)
  must stay role-only regardless; the eligible list is itself a small, explicit array reviewed the
  same way `RESOURCE_TYPES` and `ACTION_TYPES` are — adding to it is a deliberate code change, not
  a config toggle.
- **Every grant/revoke emits a domain event** (`member.grant_added`, `member.grant_revoked`) —
  guardrail 6 applies to this like everything else, and it's the one place "who can use AI /
  place calls / review PRs" changes, so it belongs in the audit chain without a special case.
- Admin UI: a new tab/section in org settings — "Permissions" — listing the closed set of
  grantable permissions, with a per-member toggle. Reuses the same member list the role dropdown
  already renders from; this is additive UI, not a rework of `settings-page.tsx`.
- **This closes the telephony gap as its first real usage**: `call:place`, `call:read`,
  `sms:send`, `sms:read`, `phoneNumber:read` move from "any Member automatically has this" to
  "granted per-member" as part of this same wave — not a separate migration later. An org that
  wants telephony available to every Member as before sets that up as a one-time bulk grant (or a
  seed default); an org that wants it locked to three reps now can express that, which it
  cannot today.

### 1.3 Test/authz-matrix implications

Guardrail 9's 235-case role×permission matrix does not shrink — it still proves what a bare role
can and cannot do. This wave adds a **second** matrix dimension: role × permission × grant-present,
proving (a) a grant adds exactly the one permission requested and nothing else, (b) a revoked
grant stops working immediately (no caching the decision across the revoke), and (c) a grant for
a permission not on the eligible list is rejected at the service layer, not silently accepted.

### 1.4 Human review

`packages/policy` is already flagged in CLAUDE.md. This wave is the first thing to change in that
package since the tuple system shipped — read every line before merge, per existing project rule.

---

## 2. AI provider foundation (`packages/ai`)

### 2.1 Why a new package, not a call site per feature

Same doctrine as `packages/security` and `packages/payments`: one file per primitive, so there is
exactly one place to audit for (a) what data leaves the process, (b) which provider/model is
active, and (c) how much it costs. No other package may call a model provider's SDK directly —
enforced the same way `packages/db`'s import ban is enforced (an ESLint rule + a
`guardrail-selftest` case), added in this wave.

### 2.2 Provider abstraction

```
interface AiProvider {
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  // request carries: model id, messages, tool definitions, org id (for redaction/logging), effort
  // result carries: content, tool calls requested, usage (input/output tokens), stop reason
}
```

One implementation to start (`AnthropicProvider`, wrapping the Claude API), following
`packages/payments`' `PaymentProvider` pattern exactly — a second provider later is an
implementation swap, not a rewrite of every call site.

### 2.3 Where this deliberately improves on the payments precedent

Investigated during planning: `PAYMENTS_PROVIDER` is a **boot-time env var** — Zod-validated at
startup (`apps/api/src/config/env.ts:529`), with no runtime picker and no admin UI; switching
providers or rotating a key means editing `.env.prod` and restarting every process that reads it.
That is a real, confirmed gap, and this phase does not repeat it for AI:

- The active provider/model **and its key** live in a new table
  (`platform.ai_provider_config` — global default) plus a per-org override table
  (`platform.ai_org_overrides`, mirroring `platform.flag_overrides`'s existing shape), not an env
  var. Keys are envelope-encrypted at rest via `packages/security`, the same way telephony
  subaccount credentials are.
- Platform admin gets a live "AI Models" tab (new, alongside the existing Orgs/Users/Flags/Audit
  tabs in `apps/web/src/features/platform-admin`) to add a model, set it as the global default,
  override it per org, and rotate a key — all without a deploy.
- Fixing `PAYMENTS_PROVIDER` to match this pattern is _not_ in scope for this phase, but is
  flagged here as a natural, low-risk follow-up once this shape exists and is proven — see §7.

### 2.4 Access gating

Two independent gates, not one, matching the split already used for `analytics`:

- **Feature flag** `aiAssistant` (new entry in `packages/feature-flags`) — "does this org's plan
  include AI at all." Per rule 7, this gates product surface only.
- **Permission** `ai:use` — added to the Wave 1 grantable-permission list from §1 — "which specific
  members inside an org-that-has-it may open the assistant." An org can be on a plan that includes
  AI and still have it granted to nobody yet, same as any other member grant.

---

## 3. Token/spend ledger and budget gate

### 3.1 Ledger, not counter — same reasoning as the telephony spend ledger

A new table, `platform.ai_usage_ledger` — one row per model call: org id, membership id
(who triggered it), tool/feature name, provider, model, input tokens, output tokens, cost in
cents (computed from a per-model rate table, same shape as telephony's carrier rate tables),
`created_at`. A durable Postgres row, not an in-process counter, for the identical reason
CLAUDE.md gives for telephony: a counter forgives everyone on restart, which is exactly the
window an attacker (or a bug) would exploit.

### 3.2 The gate runs before the call, never after

Mirrors telephony's spend-gate lesson verbatim: **the most important assertion is that the
provider was never reached**, not that a refusal was returned. Before calling `AiProvider.complete`,
sum this org's `ai_usage_ledger` cost for the current billing period (`COALESCE(actual, ...)`,
same `sumWithFallback` pattern as telephony — never a bare `SUM` that silently treats an
unreconciled row as zero-cost); if it would exceed the org's budget, refuse before dispatch.
Budgets are set per plan tier in `packages/seed/src/modules/billing.catalog.ts` (a new
`aiTokenBudgetMonthly`-style field alongside each tier's existing `features` list), with a
platform-admin override per org for exceptions.

### 3.3 Reporting

A `spendReport`-shaped query (reusing telephony's existing aggregation pattern, not reinventing
it) grouped by org and by model: total spend, per-org spend, and an estimated-bill figure —
surfaced on the platform-admin "AI Models" tab from §2.3. Gated on the platform-operator role,
same as every other operator-facing spend view.

---

## 4. The assistant itself

### 4.1 Shape: tool-calling over the existing service layer

The assistant is not a new way to mutate data — it is a new **caller** of code that already
exists. It gets a fixed, closed tool list (deliberately mirroring the automation engine's own
closed `ACTION_TYPES` — this is the same "data, not scripts" doctrine, just triggered by
conversation instead of a rule):

| Tool                                                                                    | Underlying call                          | Notes                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `search`                                                                                | existing TQL compiler/evaluator          | read-only                                                                                                       |
| `summarize_sprint` / `summarize_channel`                                                | existing analytics + card reads          | read-only                                                                                                       |
| `card.create` / `card.update` / `card.assign` / `card.set_priority` / `card.set_status` | the real `work/services` functions       | same `can()` check as a human click                                                                             |
| `sprint.create` / `sprint.add_cards`                                                    | the real sprint services                 | same `can()` check                                                                                              |
| `chat.post_message` (with `mention` nodes)                                              | existing Chat send path                  | reuses the already-whitelisted `mention` TipTap node — no new content type                                      |
| `docs.create_page`                                                                      | existing Docs service                    | used by the org-onboarding bootstrap, §6                                                                        |
| `web_search` (optional, separately toggled)                                             | Claude API's server-side web search tool | off by default; a distinct toggle from the rest, since it sends query text outside the org and costs separately |

**The assistant always acts as the person chatting with it**, using their real membership and
role — never a superuser identity. Every tool call re-runs the same `can()` check the underlying
service already requires, so a member who cannot delete a card cannot get the assistant to delete
one either. Every write still goes to the outbox in the same transaction and emits the same
domain event as if a human had clicked the button (guardrail 6) — the audit trail reads
"AI, on behalf of <user>, did X," never "AI did X."

### 4.2 Confirm-before-execute for irreversible actions

Not every tool call should run unconfirmed. `card.create`/`card.update`/`chat.post_message` are
cheap to undo and can execute directly once permitted. Bulk operations (moving many cards),
sprint creation, and anything touching another system (§4.3's PR merge/close, §7's future mail)
require the assistant to present the action and the person to confirm — the same posture this
project already takes toward its own PR-automation rules ("never auto-merge without a human
check").

### 4.3 Wave order for the assistant

1. Read-only: search + summarize + the standup view (§5) — proves the UX and the token ledger
   with the least risk.
2. Small single-card writes: create/update/assign/prioritize, always confirmed inline.
3. Sprint planning (multi-card, higher blast radius).
4. Cross-member tagging/discussion (already mostly exists via `mention` + Chat — mainly assistant
   wiring, not new primitives).

---

## 5. Standup view

A new screen, not a new subsystem — assembles data that already exists:

- Per member: cards moved to Done recently, cards still open, overdue cards (existing card/audit
  data).
- The current sprint's urgent/high-priority cards, shown by default (existing `work.sprints` +
  card priority).
- AI narrates the raw list into a short summary per person (reuses §2's provider, a `summarize`
  tool call — no new write path).
- **Cards can be moved/reassigned/reprioritized directly from this view during the meeting** —
  this is the existing `card.move`/`card.assign` mutation path, just reachable from a
  standup-shaped screen instead of the board view. No new authorization logic: same `can()`,
  same events.
- No email report as the primary surface, per direction received during planning — an optional
  emailed copy can reuse the existing notification-mail path later if wanted, but is not required
  for this wave.

---

## 6. New-org doc-space bootstrap

A small, low-risk AI feature: when a new org is created, offer to have the assistant ask a few
questions (team size, whether they want an engineering wiki vs. just a handbook) and then create
a starter Docs space — a handful of pages (Handbook, Onboarding Checklist, Engineering Wiki) —
using the `docs.create_page` tool from §4.1. Safe by construction: the org's own owner already has
full rights over their own new org's Docs space, so this needs no new permission, and page
creation is trivially reversible (delete the page). Good candidate to ship early alongside the
read-only assistant wave.

---

## 7. GitHub / PR integration (separate wave — larger, needs its own review pass)

### 7.1 What exists today (confirmed, not assumed)

- A real, working **org-level** GitHub OAuth connector: an admin with `integration:manage`
  connects an account and picks **one repo** (`apps/api/src/automation/integration.service.ts`).
  Token is envelope-encrypted per row.
- The automation engine's `github.create_issue` action is a real, non-stub call to
  `POST /repos/{owner}/{repo}/issues` using that stored token, with the target repo hard-pinned to
  the connector's own `provider_scope` (never rule-supplied) to prevent path-traversal-style
  redirection (`integration-action.service.ts:242-249`).
- **Nothing else exists**: no PR listing/reading, no comments, no review, no merge/close, no
  card↔PR link, and no connection is scoped below "the whole org" (i.e., no per-project repo
  attachment).

### 7.2 What this wave adds

- Per-member permissions on the §1 grantable list: `pr:view`, `pr:review`, `pr:merge`,
  `repo:connect`. An org admin decides who specifically gets which, exactly as with `ai:use`.
- Read tools: list PRs, fetch diff/comments, for a project's connected repo.
- Write tools: post a review comment, request changes. **Merge and close require the confirm
  step from §4.2** — draft/propose, a human executes — at least for this wave; loosening that
  later is a deliberate, separate decision, not a default.
- AI-assisted review: given a PR diff, the assistant can draft comments/a review summary using
  the same tool-calling shape as the rest of the assistant — no new AI plumbing, just new tools.
- Inbound webhook for PR events (opened/merged) — **signature verification is a human-review
  surface**, same tier as the existing Twilio webhook verification CLAUDE.md already calls out.
  Follows the same order-of-operations lesson documented for the telephony webhook: resolve the
  org from a client-supplied lookup key (the repo full name), verify the signature against _that_
  org's stored secret, and only then trust the payload.
- `pr.merged` becomes a new domain event, which the **existing** automation engine already knows
  how to react to (it triggers on any registered event name) — so "auto-move the card to Done
  when its linked PR merges" is a new trigger name plus the already-existing `card.move` action,
  not new engine work.
- A new small table linking a card to a PR (`work.card_pull_requests` or similar), and a new
  action, "create a feature branch from this card" (`POST /repos/.../git/refs`), gated behind
  `repo:connect`.

### 7.3 Human review

Webhook signature verification here gets the same scrutiny as `webhook.ts` in telephony per
CLAUDE.md's existing rule — add this file to that list once it exists.

---

## 8. Onboarding / offboarding automation

Both are "when X happens, run this checklist" — precisely what the automation engine already
does. No new subsystem, two new trigger events and a handful of new actions:

**Onboarding**, triggered on `membership.created`:

1. Add to the team's default channels (new action, `channel.add_member`)
2. Grant Docs access to the handbook/wiki space (existing permission model)
3. Assign a starter onboarding checklist of cards (existing `card.create`, or a "clone template
   cards" action)
4. Notify the manager / People contact (existing notification path)
5. Apply the role's default permission-grant bundle from §1 (so "new Engineer" gets the right
   `member_grants` automatically, not by someone remembering to click each toggle)

**Offboarding**, triggered on a new `membership.offboarding_started` event (raised by an admin
action, distinct from immediate removal):

1. Revoke active sessions immediately (existing session-revocation path)
2. Reassign open/in-progress cards to someone else — **new** action, `cards.bulk_reassign`
   (bulk, so needs the §4.2 confirm treatment if ever exposed to the assistant directly, and its
   own audit event since it's a new mutation shape, not a loop of existing ones)
3. Revoke `member_grants` rows (§1) and connected-tool access (repo, telephony)
4. Remove from channels, **without deleting** their message history — reuses the existing
   legal-hold/retention mechanism from Phase 5, not a new deletion path
5. Final audit entry confirming the checklist completed

---

## 9. Non-goals for this phase, and why

- **In-house email.** Explicitly descoped during planning: Chat + card comments already cover
  internal discussion; a "compose and send from your work address" feature (the email analogue of
  telephony's click-to-call) is a real, separate, standalone piece of work with its own domain
  concerns (sender-domain verification, deliverability) that costs nothing extra to defer — it
  does not block anything above.
- **Self-hosted / "our own" LLM.** Technically possible (open-weight models on owned GPU
  infrastructure) but a large ongoing infrastructure and quality trade-off for a
  solo-maintained product; nothing in §2's `AiProvider` interface forecloses adding a
  self-hosted implementation later if cost or data-residency ever demands it — it is exactly the
  kind of swap the interface exists to make cheap.
- **Meeting/call → action-item → card automation.** Investigated during planning and found to
  need more groundwork than expected: TaskFlow's phone-call transcription
  (`comms.transcripts`, real, redacted-at-rest text) only covers **Twilio outbound/inbound phone
  calls** — a feature aimed at support/sales-style calling, not something regular team members are
  expected to use for meetings (see §0 point 3 on why that access is being tightened, not
  expanded). The in-app WebRTC calling feature teams actually use for meetings has **no
  transcription pipeline at all** — Phase 13's own status notes the browser is the only place the
  full call audio exists, with no server in the media path, so building this would mean adding a
  new upload-and-transcribe step first. Worth revisiting once §1–§8 are stable, not before.
- **An externally-facing MCP server** (letting an outside AI client like Claude Desktop connect to
  TaskFlow). What this phase builds is the internal tool-calling pattern MCP also uses, but as
  first-party tools inside TaskFlow's own API. Exposing that same tool set over the actual MCP
  protocol to external clients is a distinct, later decision with its own auth/scoping questions.
- **Narrowing a role's default permissions per member** (the inverse of §1 — taking capability
  _away_ from one person that their role would otherwise grant). Flagged as a known harder
  problem and deliberately left out of Wave 1's grant model, which only ever adds capability.

---

## 10. Suggested build order

1. §1 member grants (foundation; fixes the telephony gap as part of the same migration)
2. §2 + §3 in parallel (`packages/ai` provider wrapper + the usage ledger) — retrofitting spend
   tracking after the fact is the mistake to avoid, per the telephony precedent
3. §4 wave 1 (read-only assistant) + §6 (org doc-space bootstrap) — cheap, low-risk, proves the
   pattern end to end
4. §5 (standup view) — mostly UI + the same read tools as step 3
5. §4 waves 2–4 (write actions, sprint planning, tagging)
6. §7 (GitHub/PR) — largest single piece, needs its own human-review pass given the webhook
   signature work
7. §8 (onboarding/offboarding automation) — can start any time after §1, since it only needs the
   automation engine and the grant model, not the assistant itself

## 11. Open questions to settle before/while building

- Exact wording and final list of permissions eligible for member grants in Wave 1 (§1.2) —
  proposed starting set: `ai:use`, `call:place`, `call:read`, `sms:send`, `sms:read`,
  `phoneNumber:read`, `pr:view`, `pr:review`, `pr:merge`, `repo:connect`.
- Default AI model and default per-tier token budget (§2, §3.2) — needs a real number, not a
  placeholder, before the budget gate can be tested meaningfully.
- Whether `web_search` ships at all in Wave 1 of the assistant, or is held back to a later wave
  given its distinct data-egress and cost profile (§4.1).
- Whether merge/close in §7.2 ever graduates from confirm-required to AI-direct for a trusted
  role, and if so, which role — left open rather than decided here.
