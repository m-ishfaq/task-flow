# Phase 12, Wave 1 — Org governance & platform admin

**Status: DRAFT, not yet approved. Written 2026-08-08.** Recommendations throughout, following
`ai/phase-4-realtime.md` §7's and `ai/phase-11.5-people.md` §7's own precedent — a human signs off
before any of this is built, and §7 below is exactly the list of calls that need one.

Parent: [PLAN.md](../PLAN.md) §13 (Roadmap, row 12).

This is **one wave of Phase 12**, not the whole row. Phase 12's roadmap line also covers
retention policies, DSAR export, crypto-shred erasure, TOTP, OAuth account linking, device
inventory, impossible-travel detection, and SCIM/SAML — none of that is in scope here. This wave
is the part of Phase 12 that came up investigating a specific question: _self-serve org creation
lets anyone become an Owner of their own tenant, so what stops that from being a mess, and what
does an actual admin look at across the whole system?_ Everything below answers that question and
nothing else. SaaS billing (plans, seats, Stripe) is explicitly **not** in this wave either — see
§2.

---

## 1. Why this phase exists

Self-serve org creation is not a bug. `apps/api/src/tenancy/router.ts:15-26` and
`org.service.ts:40-54` already say so directly: any authenticated user can call `orgs.create` and
become the Owner of a brand-new, empty tenant, with no permission check, because a permission
required to create your _first_ org is a permission every role would need to hold — which is a
permission that means nothing. This is the same growth motion Slack, Notion, Linear, and Asana all
use. Restricting who can create an org would break it. Nothing in this wave changes that.

What investigating it turned up instead is three concrete, unglamorous gaps, plus the thing that
was already known to be missing (a platform-wide view):

1. **No abuse controls on creation.** `orgs.create` has no email-verification gate and no rate
   limit. `identity.users.emailVerifiedAt` already exists (Phase 1) and is simply not checked
   here; an unverified account can create unlimited orgs today.
2. **`identity.orgs.status` is a dead column.** It exists (`text`, default `'active'`, migration 0004) with no `CHECK` constraint and, per a repo-wide grep, **zero readers**. Compare
   `identity.users.status`, which login (`identity.service.ts:206`, `passkey.service.ts:218`)
   actually enforces. An org's `status` column looks like a suspend switch and is not wired to
   anything — flipping it today would do precisely nothing.
3. **Ownership can be created but never cleanly handed off.** `member.service.ts`'s `changeRole`
   technically allows promoting a target to `'owner'` (its input schema is the full `Role` enum,
   not `DIRECTLY_ASSIGNABLE_ROLES`) — but `admin/settings-page.tsx`'s role dropdown deliberately
   excludes `'owner'` from what it renders (CLAUDE.md, Phase 3 card-detail notes cross-reference),
   so there is **no UI path to it at all**. And `changeRole` unconditionally refuses
   `target.userId === actor.userId` ("nobody changes their own role") — so even calling the route
   directly, an Owner cannot demote _themselves_ in the same call that promotes someone else. The
   only way to hand off ownership today is two separate, non-atomic calls by two different
   people (A promotes B to owner; B, now also an owner, demotes A) — a workaround nobody can
   discover from the product, that leaves an org with two Owners in between, and that nothing
   guarantees ever actually completes the handoff.
4. **No platform-wide view exists at all.** Every admin surface in `apps/web/src/features/admin`
   (`settings-page.tsx`, `permission-debug-page.tsx`, `audit-page.tsx`) opens `withOrgScope` for
   whichever org is currently selected. There is no user who can see "how many orgs exist," no way
   to suspend one that's actually enforced (see #2), and no cross-org user directory. This is the
   part of Phase 12's roadmap line ("Admin console") this wave actually builds.

None of these four are reachable by an ordinary org Owner acting on their own tenant — they are
all either missing enforcement (#2), missing UI for a route that already exists (#3), or missing
an entire trust tier that doesn't exist in the codebase yet (#4). That last point is the one worth
stating plainly before any schema work starts.

## 2. What's in scope, and what is deliberately not

**In scope:** email-verification and rate-limit gates on `orgs.create`; enforcing
`identity.orgs.status`; a dedicated, atomic ownership-transfer route and UI; a new, narrow
platform-operator trust tier with a console covering an org directory (list, suspend, reactivate),
a user directory (read-only in this wave — see §7.5), and a feature-flag admin UI wrapping
`packages/feature-flags`.

**Out of scope, and why each is a real constraint:**

- **Billing, plans, seats, trial state.** Nothing in `identity.orgs` gains a plan or seat column
  in this wave. This is explicitly a later, separate phase — self-serve creation today produces an
  unlimited-everything tenant forever, and that stays true until a SaaS-readiness phase is
  scoped on purpose, not as a side effect of an admin console. Naming it here so the gap is a
  known deferral, not an oversight the next reader has to rediscover.
- **Org deletion.** `org:delete` is already a real permission in `packages/policy/src/permissions.ts`
  (Owner-only in the matrix) with **zero routes** implementing it — a placeholder built "ahead of
  the day one is added" (that file's own comment). This wave does not add that route, for either
  an Owner or a platform operator. Suspending an org is reversible and low-stakes enough for Wave
  1; deletion touches every product's data and belongs with Phase 12's retention/DSAR/crypto-shred
  work, which is a later wave of the same phase, not this one.
- **User suspension.** The read side already exists — `identity.users.status !== 'active'` already
  blocks login and passkey auth. The write side (a route that sets it) does not, and this wave
  does not add one. Freezing an arbitrary account platform-wide is a bigger, more sensitive
  capability than suspending an org, and it sits naturally with Phase 12's device-inventory /
  impossible-travel work rather than shipping as a side effect of building the org directory. §7.5
  makes this an explicit decision to confirm, not a silent cut.
- **Cross-org data access.** A platform operator in this wave can see _that_ an org exists, how
  many members it has, and whether it's suspended — never a board, a card, a chat message, or a
  doc page belonging to it. That is a structurally different, much larger capability (it needs
  either an RLS-bypassing Postgres role or an audited impersonation flow) and is not this wave's
  job. If a later wave needs it, it is sized and reviewed on its own, the same way Phase 6 sized
  `taskflow_backlinks`' column-level grant as its own decision rather than reusing `withGlobalScope`
  for something RLS was never designed to allow.
- **Operator self-management.** No `platformAdmin.operators.grant`/`.revoke` route or UI. §7.7
  explains why Wave 1 doesn't need one.
- **TOTP, OAuth, device inventory, impossible-travel, SCIM, SAML, DSAR export, crypto-shred, SOC 2
  evidence.** All still Phase 12's row in PLAN.md §13, all later waves of the same phase, untouched
  by this document.

## 3. Structural decisions

### 3.1 A platform operator is not an org role, and does not go in `packages/policy`'s existing catalog

`packages/policy`'s `can()`, `RESOURCE_TYPES`, and `PERMISSIONS` are all built around one
assumption that holds everywhere else in this codebase: a subject's authority comes from an
`identity.memberships` row and is relative to exactly one org. A platform operator's authority is
relative to _no_ org — extending `RESOURCE_TYPES` with `'platform'` and writing permissions like
`platform:read` would bend `can(subject, permission, target?)` into describing something it isn't:
there is no membership row, no `target`, and no org whose RLS session variable would confine a
mistake the way it confines every other permission check in this system.

So this is a **second, deliberately small and separate primitive**, not an extension of the first:

```sql
-- New table in the existing platform schema (packages/db/src/schema/platform.ts already
-- defines this schema for outbox/notifications/attachments — this is a fifth tenant of it).
CREATE TABLE platform.operators (
  user_id     uuid PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,
  granted_by  uuid NOT NULL REFERENCES identity.users (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  note        text NOT NULL  -- who this is and why, free text, never blank (§7.6's audit argument)
);
```

No `role` column, no scoped permissions within it. §7.1 is the explicit call to confirm, but the
recommendation is a flat flag for Wave 1: everyone in this table can do everything this wave's
console offers (view orgs, suspend/reactivate, view users read-only, manage flags), because the
capability surface is small and fixed, and a scoping mechanism for a table with (realistically) one
or two rows is exactly the speculative abstraction CLAUDE.md's working agreement asks not to build
before a second need shows up.

`packages/policy/src/platform-operator.ts` (new file, small, mirroring `assignment.ts`'s reasoning
for why role-adjacent decisions get their own module rather than inline comparisons) exports:

```ts
export async function isPlatformOperator(userId: UserId): Promise<boolean>;
```

reached only through `withGlobalScope` — no org context exists to check against, the same honest
reason `orgs.list` and `passkey.repository.ts` already use it. This is the first product surface to
use `withGlobalScope` **outside the identity module**, and that requires a deliberate, reviewed
change to `packages/config/eslint/security.js`'s existing carve-out (currently scoped to
"the identity module" alone, per that file's own comment) — not a suppression, an intentional
widening with a comment explaining why, exactly as CLAUDE.md's own working agreement requires.

### 3.2 A new route kind: `platformRoute`

`apps/api/src/trpc/builder.ts` already has four route kinds (`route`, `selfRoute`, `memberRoute`,
`publicRoute`); this wave adds a fifth, following the same shape as the other three
non-`publicRoute` kinds — authenticate, then apply one more check before the handler runs:

- Requires a valid session (same as every non-public route).
- Does **not** call `resolveOrgMembership` — a platform-admin request carries no
  `x-taskflow-org` header and needs none.
- Calls `isPlatformOperator(ctx.principal.userId)`; anything false gets the same `FORBIDDEN` shape
  every other permission boundary in this codebase already returns — an honest denial, not a
  disguised 404. (§8.2's "the UI never re-derives authorization" holds here exactly as it does
  everywhere else: the `/platform-admin` pages render for anyone who reaches the URL and let the
  server's answer decide what's visible, same as the permission-debug page already does.)
- **Every `platformRoute` requires step-up**, unconditionally, no per-route opt-out. Unlike
  `route()`, where `stepUp` is an explicit per-route flag because most permissions don't warrant
  it, everything reachable through this builder is cross-tenant by definition, and PLAN.md §8.1
  already treats "acting across tenant boundaries" at the same severity as the operations already
  on the step-up list (role changes, member removal, workspace deletion).

### 3.3 Making `identity.orgs.status` real

Two changes close the gap in §1.2:

1. **Migration**: add `CHECK (status IN ('active', 'suspended'))` to `identity.orgs.status` —
   today it's an unconstrained `text` column, which means a typo in a future writer would silently
   create a third, unrecognized state nothing checks for either.
2. **Enforcement**, in `apps/api/src/tenancy/resolve.ts` (⚠ human-review surface already, per
   CLAUDE.md — this file decides the role every subsequent check is evaluated against, and this
   is exactly the kind of change that belongs on that reviewer's desk): after
   `resolveOrgMembership` finds a real membership row, check the org's `status`. A suspended org
   should **not** collapse into the existing `NOT_A_MEMBER` outcome — that error already means
   something specific ("you were never in this org, or you were removed"), and reusing it for "the
   org itself is suspended" would tell a legitimately-still-a-member Owner the wrong thing about
   what happened and what to do next. New error, `ORG_SUSPENDED`, distinct message, same fail-closed
   shape.

### 3.4 Self-serve creation guardrails

`org.service.ts::createOrg` gains one precondition, checked before the transaction opens:
`actor`'s `identity.users.emailVerifiedAt` must be non-null, or the mutation refuses with a
validation error telling the caller to verify their email first. This is a guard on infrastructure
that already exists (Phase 1's verification flow) — no new plumbing.

`middleware/rate-limit.ts`'s `OPERATION_RULES` gains an `orgs.create` entry, following the existing
per-account-keyed pattern (`auth.login`'s `{ limit: 5, windowMs: 15 * 60_000 }` is the nearest
precedent in shape, not in number — §7.3 is the number to confirm).

### 3.5 Ownership transfer: one atomic route, not two calls by two people

New `members.transferOwnership` in `member.service.ts`, replacing the accidental two-step
workaround in §1.3 with a single transaction:

```ts
export async function transferOwnership(
  orgId: OrgId,
  input: { readonly toUserId: UserId; readonly selfNewRole: 'admin' | 'member' },
  actor: Actor,
): Promise<{ readonly newOwnerId: UserId }>;
```

Both writes — promote `toUserId` to `'owner'`, demote `actor.userId` to `input.selfNewRole` —
happen in the same `withOrgScope` transaction the existing `changeRole` already opens one of, so
the org is never observably ownerless and never observably has the _old_ owner still holding the
role after the call returns; `assertAnotherOwnerRemains`-style counting is unnecessary because
the two writes commit together rather than needing to reason about a moment in between. The route
is `route({ permission: 'member:manage', stepUp: true })` — since `member:manage` is already
Owner-only in the role matrix (CLAUDE.md, Phase 3 card-detail notes), the permission check alone
already guarantees the caller currently holds the role they're giving away; no extra "are you
really the owner" check is needed beyond what `member:manage` already means.

UI: `admin/settings-page.tsx` gets a distinct **"Transfer ownership"** action, separate from the
existing role-management dropdown (which keeps excluding `'owner'`, unchanged) — a confirmation
dialog naming the new owner and the caller's own resulting role, step-up prompted the same way
member removal already is. This is the dedicated flow the settings page's own existing comment
already anticipated ("transferring ownership is not a role change, and offering it in this
dropdown would render a control that always fails") — this wave is what makes that comment stop
being a description of a gap.

### 3.6 API surface — a new `apps/api/src/platform-admin` module

Mirrors the existing per-product layout, mounted in `apps/api/src/router.ts` as a top-level
`platformAdmin` namespace, every route `platformRoute` (§3.2):

- `platformAdmin.self.check` — no input, returns `{ isOperator: boolean }`. The one route a
  non-operator can call successfully (it answers the question rather than refusing to), so
  `apps/web` can decide whether to render a link to `/platform-admin` at all without guessing.
- `platformAdmin.orgs.list` — paginated (§7.5 note on `people.directory.list`'s own open
  pagination question applies identically here, at platform scale it should default to yes):
  `{ orgId, name, slug, status, memberCount, createdAt }` per row, via `withGlobalScope`.
- `platformAdmin.orgs.suspend` / `.reactivate` — writes `identity.orgs.status`, emits an event
  (§4), targets one org by id.
- `platformAdmin.users.list` — read-only in this wave (§2): `{ userId, email, emailVerifiedAt,
status, orgCount, createdAt }` via `withGlobalScope`. No mutation route.
- `platformAdmin.flags.list` / `.set` — thin wrapper over `packages/feature-flags`'s existing
  provider interface; this wave adds the UI, not new flag infrastructure.

### 3.7 Web UI surface

- **`/platform-admin`** (new top-level route tree in `apps/web/src/router.tsx`, entirely outside
  the org-scoped shell — no sidebar, no org switcher, because none of it is org-scoped): calls
  `platformAdmin.self.check` to decide whether to render a link from the account menu at all, and
  otherwise behaves like every other permission boundary in this codebase — a non-operator who
  navigates there directly gets the ordinary `ErrorView` FORBIDDEN, not a fake 404 (§3.2).
  - **Orgs tab**: searchable list, suspend/reactivate action with confirmation + step-up.
  - **Users tab**: searchable, read-only list (§2).
  - **Flags tab**: existing flag catalog, toggle per flag, no per-org override UI (that's a
    separate, larger feature if it's ever wanted — this wave's flags stay global, matching how
    `packages/feature-flags` already works).
- **`admin/settings-page.tsx`** gains the Transfer Ownership action (§3.5). Nothing else on that
  page changes.

## 4. Event catalog

Four new events, `<resource>.<past_tense_verb>`, guardrail 11 applies with no exception — every one
emitted inside the mutation's own transaction:

- **`platform.orgSuspended`** / **`platform.orgReactivated`** — `{ orgId, operatorUserId }`.
- **`member.ownershipTransferred`** — `{ orgId, fromUserId, toUserId, fromNewRole }`, its own event
  rather than two generic `memberRoleChanged` events, for the identical reason
  `ai/phase-11.5-people.md` §3.6 gives for `reportingLine.changed`: a structural, sensitive fact
  deserves to be independently greppable in the audit log rather than requiring a reader to
  reconstruct "these two role changes were actually one handoff" from two unrelated-looking rows.
- **`platform.operatorGranted`** — emitted by whatever inserts a `platform.operators` row. Wave 1
  ships with no self-service route for this (§7.7), so in practice this event's only producer
  is a migration/seed script — still worth a real event definition rather than an unaudited manual
  `INSERT`, because "who has platform-operator access and since when" is exactly the kind of
  question this system's audit log exists to answer.

**Where these get audited is §7.2 — the one open question in this section.** The existing
hash-chained audit log (`audit.audit_log`) is per-org by construction (Phase 2: a trigger under a
per-org chain-head lock). `platform.orgSuspended` has a real `orgId` and could write into that
org's own chain — an Owner arguably _should_ see "a platform operator suspended this org" in their
own audit history. But `platformAdmin.orgs.list` and `platformAdmin.users.list` (read-only,
cross-org) have no single org to attribute to at all. §7.2 lays out the choice.

## 5. Waves

Given the size of what's already broken out above, this document proposes shipping it as **one
wave**, not further split — unlike Phase 3.5 or Phase 11.5, nothing here has an independent,
separately-valuable stopping point partway through: an operator console with no way to make
`identity.orgs.status` mean anything is decoration, and enforcement with no console to trigger it
from is a column nobody can safely flip. If review disagrees, the natural split is schema +
enforcement + ownership-transfer (no new trust tier, ships alone) as a first slice, with the
platform-operator console as a second — noted here as an option, not the recommendation.

**Acceptance:**

- An unverified account cannot create an org; a verified one hitting the rate limit gets a clear,
  distinct error, not a generic 500.
- Suspending an org through the console actually breaks every route for its members
  (`ORG_SUSPENDED`, not silent success) and reactivating restores them.
- An Owner can transfer ownership to another member in one action; the org has exactly one Owner
  before and after, never zero, never observably two.
- A non-operator hitting any `/platform-admin` route or page gets an honest FORBIDDEN.
- `pnpm --filter @taskflow/db migrate:verify` passes; guardrail selftest passes with the new
  `withGlobalScope` carve-out asserted, not merely un-broken.

## 6. Cross-cutting obligations

**This module joins CLAUDE.md's `⚠ human-review` list.** `apps/api/src/platform-admin`,
`packages/policy/src/platform-operator.ts`, and the `withGlobalScope` carve-out in
`packages/config/eslint/security.js` all belong there — this is a new privilege-escalation surface
of the same shape as `apps/api/src/identity` and `apps/collab/src/auth.ts`, and CLAUDE.md's own
rule ("a second adversarial AI pass in a fresh context is expected, not optional") should apply to
it from the first PR, not retroactively once something goes wrong.

**Guardrail 8 (tenancy fuzz) does not apply directly** — `platformRoute` has no org context to
substitute a foreign org's id into, the same documented `not-applicable` outcome
`ai/phase-11.5-people.md` §6 already established for `people.profile.*`. What the fuzz harness
_should_ gain is the mirror case: a regular org member (any role, any org) calling a
`platformAdmin.*` route and getting FORBIDDEN, proving the platform/org boundary holds in the
direction that actually matters day to day.

**Tests ship with the slice**, named explicitly: a test proving `transferOwnership` never produces
a zero-owner or observably-two-owner window even under concurrent calls (the same discipline
`member.service.ts`'s existing owner-count tests already apply to `changeRole`/`removeMember`); a
test proving a suspended org's routes fail closed for every role, including its own Owner; a test
proving the email-verification and rate-limit gates on `orgs.create`; a test proving
`isPlatformOperator` returns false for every ordinary user by default (the one-line assertion that
would catch an accidental default-allow, the same category of bug CLAUDE.md's Chat notes call out
for `closed` on a channel's `can()` target).

## 7. Decisions — for review

Following `ai/phase-4-realtime.md` §7's and `ai/phase-11.5-people.md` §7's own precedent:
recommendations, not decisions a human has signed off on yet.

1. **Flat operator flag vs. scoped operator roles from Wave 1** (§3.1). Recommendation: flat flag
   now; revisit if a second operator with narrower needs (e.g. read-only support access) actually
   shows up. Confirm, or scope roles into `platform.operators` now if that's foreseeable soon.
2. **Where platform-operator actions get audited** (§4). Three options: (a) write into the target
   org's own `audit.audit_log` when there is one, using the org's real `orgId` and no
   platform-specific table at all; (b) a separate, globally-chained `platform.operator_audit_log`
   for everything, including the org-scoped actions, so "everything an operator has ever done" is
   one query; (c) both — write to the org's chain for org-scoped actions AND a separate global log
   for the full operator history. Recommendation: (c) — an Owner's own audit trail should show
   "a platform operator suspended this org" without them needing operator access to see it, and a
   platform operator's own accountability record shouldn't depend on the target org still existing
   to query it from. This is the single costliest-to-reverse decision in this document, worth the
   most scrutiny of the seven.
3. **The `orgs.create` rate-limit number** (§3.4). No strong precedent to copy — `auth.login`'s
   numbers are about guessing a password, a different shape of abuse. Proposing 3 per account per
   24 hours as a starting point (generous for a legitimate person setting up a company and a
   personal workspace in the same day; cheap to raise later, expensive to have left unset).
4. **`ORG_SUSPENDED` as a new error code vs. reusing `NOT_A_MEMBER`** (§3.3). Recommendation:
   new code, per the reasoning given there. Confirm, since it touches `packages/contracts/errors.ts`
   and every client-side error-message table that switches on error codes.
5. **User suspension: confirmed out of scope for this wave, or pull it in?** (§2). Recommendation:
   defer to a later Phase 12 wave alongside device inventory / impossible-travel, both because it's
   a materially bigger capability than org suspension and because it has no natural home in an
   "orgs and ownership" wave. Confirm this is acceptable, since "the admin console can't freeze an
   account" may read as an obvious gap to whoever uses it first.
6. **Migration numbering.** `packages/db/migrations` ends at `0031` on `main` as of this writing.
   This document doesn't hardcode a number for the same reason `ai/phase-11.5-people.md` §7.4
   didn't — claim the next one actually free at merge time.
7. **Bootstrapping the first operator.** Wave 1 ships with no self-service
   `platformAdmin.operators.grant` route (§2) — the first row(s) in `platform.operators` are
   inserted by migration or a one-off script run by whoever actually operates the deployment, the
   same unprivileged-by-necessity bootstrap every other "there is no one yet to grant this"
   moment in this codebase already has (the first user, the first org). A self-service
   grant/revoke UI is worth building once there's more than one operator managing the others;
   confirm that's really not needed for Wave 1's actual first deployment.

## 8. Sequencing and cost

Depends on Phase 1 (email verification — complete), Phase 2 (memberships, role matrix — complete),
and `packages/feature-flags` (Phase 0B — complete). Independent of Phases 8–11; does not need to
wait behind any of them, the same reasoning `ai/phase-11.5-people.md` §8 already applies to its own
position in the numbered-but-unordered back half of the roadmap.

**Phase 7 is the one exception, and the dependency runs one way.** This phase does not need
anything from Phase 7. Phase 7 needs one thing from this phase — see §9.

New surface, sized against Phase 12's overall 6-week estimate: one new table
(`platform.operators`), one altered column (`identity.orgs.status` gains a `CHECK`), one new route
kind (`platformRoute`), one new API module, one new ESLint carve-out (with its
`guardrail-selftest` case), four new events, one new top-level web route tree, and one new entry on
CLAUDE.md's human-review list. Comparable in size to Phase 4's Wave 1 (a new gateway-adjacent trust
boundary) rather than to Phase 9 or 11.5's larger multi-wave scope — **estimate: 2–3 weeks**,
leaving the rest of Phase 12's 6-week line (retention, DSAR, crypto-shred, TOTP, OAuth, device
inventory, SCIM/SAML, SOC 2) as later waves of the same phase, unsized here.

## 9. Interaction with Phase 7 (Voice & Messaging)

Checked against PLAN.md §8.5, not assumed: that section already names toll fraud / SMS pumping as
**"the single most expensive failure mode in the system,"** with a per-org hard spend cap as the
runtime control. This wave doesn't touch billing or telephony at all (§2), but building it surfaced
a real, one-directional dependency worth recording here rather than leaving for whoever scopes
Phase 7 to rediscover.

**What this wave gives Phase 7 for free.** §3.3's `ORG_SUSPENDED` enforcement lives in
`resolveOrgMembership` — the function every authenticated, org-scoped tRPC route already calls
before its handler runs. So the moment both phases exist, every Phase-7 route that goes through
that ordinary path (buying a number, click-to-call, sending an SMS from the Chat inbox) is already
refused for a suspended org, with no Phase-7-specific code required. This is the same "enforcement
point already exists, a new phase just starts hitting it" property Phase 9 and Phase 5 both got
from `withOrgScope`/RLS for free.

**What it does not cover, and why that's a structural gap rather than an oversight to patch here.**
Telephony's actual cost risk lives almost entirely OUTSIDE the request-authentication path this
wave enforces at:

- An **inbound** Twilio webhook (a call or SMS arriving) authenticates via `X-Twilio-Signature`
  (§8.5), not a user session — there is no `x-taskflow-org` header, no `resolveOrgMembership` call,
  nothing for `ORG_SUSPENDED` to intercept.
- An **outbound** send from a queued job, a scheduled IVR step, or (once Phase 10 exists) an
  automation action runs on a worker with no request context at all.
- The spend-cap check itself (§8.5, "per-org hard spend caps with automatic cutoff") is exactly
  this kind of out-of-request accounting logic.

An org suspended through this wave's console would therefore, as designed today, still be able to
receive calls and — more importantly, given §8.5's own framing of where the money risk is — still
have any already-queued or automation-triggered outbound telephony action fire, because nothing in
that path ever asks whether the org is suspended.

**What Phase 7 needs to do about it, when it's scoped.** Treat `platform.orgSuspended` (§4) as a
subscribed event, not an HTTP-layer concern: whatever holds the spend-cap state (§8.5) needs a
fast, request-context-independent "is this org frozen" check consulted immediately before any
outbound Twilio API call — the same shape as the spend cap check itself, run alongside it rather
than instead of it, since they answer different questions ("can this org afford this" vs. "is this
org allowed to do anything at all"). A stretch goal worth naming for whoever scopes Phase 7: also
pause the org's Twilio **subaccount** itself (Twilio's own subaccount-suspend API) on
`orgSuspended`, not only refuse the action on our side — a leaked or compromised org's Twilio
credentials otherwise remain independently usable directly against Twilio, bypassing this
application entirely, which the per-org-subaccount credential-compromise control (§8.5) already
implies matters.

**Sequencing.** This document's own position (§8) is that this wave doesn't need to wait on
anything past Phase 2. Phase 7 is the reverse case: given §8.5 already calls toll fraud the most
expensive failure mode in the system, shipping Phase 7 before this wave exists means shipping it
with automatic spend-cap cutoffs but no operator-initiated kill switch for the org itself — not
wrong, but worth being a deliberate choice rather than a gap discovered during a real incident. If
Phase 7 is scoped first for other reasons, it should stand up its own minimal org-freeze primitive
and treat adopting this wave's `platform.orgSuspended` event later as a straightforward swap, the
same forward-compatible shape §5's provider-interface pattern uses elsewhere in this codebase —
not a reason to ship Phase 7 with no equivalent control at all.
