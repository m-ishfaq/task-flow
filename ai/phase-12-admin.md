# Phase 12, Wave 1 — Org governance & platform admin

**Status: SHIPPED.** Written 2026-08-08; §7's seven open decisions answered the same day;
corrected against the real codebase (migrations, ESLint config, RLS policies) the same day again —
see the correction note just below. This header said "DRAFT, not yet approved for build" long
after the wave shipped — CLAUDE.md's own Phase 12 Wave 1 section documented the flat operator flag,
the org directory, flag overrides, the operator audit log, `platformRoute`, ownership transfer, and
suspension enforcement as built in detail, and a sibling spec
([phase-12-wave3.md](phase-12-wave3.md)) already called this wave "shipped" in its own text, while
this file's own header still claimed nothing had been approved. Left corrected in place rather than
silently rewritten, per this repo's own "a status marker is a claim, not a fact" discipline
(CLAUDE.md).

Parent: [PLAN.md](../PLAN.md) §13 (Roadmap, row 12).

This is **one wave of Phase 12**, not the whole row. Phase 12's roadmap line also covers
retention policies, DSAR export, crypto-shred erasure, TOTP, OAuth account linking, device
inventory, impossible-travel detection, and SCIM/SAML — none of that is in scope here. This wave
is the part of Phase 12 that came up investigating a specific question: _self-serve org creation
lets anyone become an Owner of their own tenant, so what stops that from being a mess, and what
does an actual admin look at across the whole system?_ Everything below answers that question and
nothing else. SaaS billing (plans, seats, Stripe) is explicitly **not** in this wave either — see
§2.

**Corrected after a verification pass against the actual code**, not merely reviewed for
reasoning — checked against the migrations, the ESLint config, and the RLS policies actually in
the repo. Three claims in the first draft did not hold up, and all three are fixed in place below
rather than patched around:

- §1.2 claimed `identity.orgs.status` has no `CHECK` constraint. It does (migration 0004,
  `orgs_status_valid`), and it already includes a third value, `'deleted'`, the first draft never
  accounted for. Fixed in §1 and §3.3 — the real gap was always enforcement, not the column shape,
  and this wave no longer proposes a migration that would have conflicted with the existing
  constraint.
- §3.1 claimed this wave would be "the first product surface to use `withGlobalScope` outside the
  identity module." `apps/api/src/people/**` is already exempt
  (`packages/config/eslint/security.js`, added for Phase 11.5). The actual change is smaller than
  described — adding one more path to an existing exemption, not opening a new one. Fixed in §3.1.
- §3.6 proposed reading `identity.orgs` through `withGlobalScope`. That table has `FORCE ROW LEVEL
SECURITY` with a policy keyed on `app.org_id`, and `withGlobalScope` clears both session
  variables — every query would silently return zero rows, and every write would be refused. This
  directly contradicted §2's own correct statement that cross-org data access needs "an
  RLS-bypassing Postgres role or an audited impersonation flow." Fixed in the new §3.7, which adds
  exactly that role, following the `taskflow_audit`/`taskflow_backlinks`/
  `taskflow_notification_sweep` precedent. `platformAdmin.users.list` is unaffected —
  `identity.users` carries no RLS at all, the same reason login can look up any account by email.
- §4's event catalog named the events in camelCase (`platform.orgSuspended`,
  `member.ownershipTransferred`, `platform.operatorGranted`). The registry
  (`packages/events/src/registry.ts`) accepts only `<resource>.<past_tense_verb>` in snake_case,
  and `defineEvent('platform.orgSuspended')` throws at module load — it took down `tsx watch`
  before the server started. Corrected in §4 and §9 to the names actually registered:
  `platform.org_suspended` / `platform.org_reactivated` / `member.ownership_transferred` /
  `platform.operator_granted`.

Seven further gaps the first draft simply didn't ask about are folded into the design below
(§3.1, §3.2, §3.5, §3.8, §3.9) rather than kept as a separate list — a plan that names a gap
without closing it is barely better than one that doesn't name it.

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
2. **`identity.orgs.status` is real but unenforced.** It has a `CHECK` constraint
   (`orgs_status_valid`, migration 0004) covering three values — `'active'`, `'suspended'`, and
   `'deleted'` (the last paired with a `deleted_at` timestamp, both there for a future soft-delete
   this document does not build — migration 0004's own comment ties it to §7.1) — and, per a
   repo-wide grep, **zero readers**. Compare `identity.users.status`, which login
   (`identity.service.ts:206`, `passkey.service.ts:218`) actually enforces. The column's shape was
   never the problem; nothing checks it.
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
a user directory (read-only in this wave — see §7 decision 5), and a feature-flag admin UI wrapping
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
  impossible-travel work rather than shipping as a side effect of building the org directory. §7
  decision 5 makes this an explicit, decided deferral, not a silent cut.
- **Cross-org data access.** A platform operator in this wave can see _that_ an org exists, how
  many members it has, and whether it's suspended — never a board, a card, a chat message, or a
  doc page belonging to it. §3.7 does add a narrow, `NOBYPASSRLS` cross-tenant role for exactly the
  org/membership **control-plane** tables this wave's console needs — that is not the same
  capability as reading a tenant's **product** data, which stays structurally out of reach: no
  policy this wave adds names `work.cards`, `chat.messages`, or any other product table, and
  reaching those legitimately would need either a differently-scoped role or an audited
  impersonation flow, sized and reviewed on its own if a later wave needs it — the same way Phase 6
  sized `taskflow_backlinks`' column-level grant as its own decision rather than reusing
  `withGlobalScope` for something RLS was never designed to allow.
- **Operator self-management.** No `platformAdmin.operators.grant`/`.revoke` route or UI. §7
  decision 7 explains why Wave 1 doesn't need one.
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
  note        text NOT NULL  -- who this is and why, free text, never blank (accountability, §4)
);
```

No `role` column, no scoped permissions within it — §7 decision 1: a flat flag for Wave 1.
Everyone in this table can do everything this wave's console offers (view orgs, suspend/reactivate,
view users read-only, manage flags), because the capability surface is small and fixed, and a
scoping mechanism for a table with (realistically) one
or two rows is exactly the speculative abstraction CLAUDE.md's working agreement asks not to build
before a second need shows up.

`packages/policy/src/platform-operator.ts` (new file, small, mirroring `assignment.ts`'s reasoning
for why role-adjacent decisions get their own module rather than inline comparisons) exports:

```ts
export async function isPlatformOperator(userId: UserId): Promise<boolean>;
```

reached only through `withGlobalScope` — `platform.operators` carries no `org_id` and no RLS (the
table above), the identical reasoning `people.profiles` already established. The carve-out this
needs is smaller than it first looks: `packages/config/eslint/security.js`'s
`exempt-global-scope-consumers` block already covers `apps/api/src/identity/**` **and**
`apps/api/src/people/**` (added for Phase 11.5, for the same "non-tenant table, no org known yet"
reason) — this wave adds one more path, `apps/api/src/platform-admin/**`, to an existing list
rather than opening a new exemption. The `packages/guardrail-selftest` case for that block needs
extending to assert the new path is covered, and the block's own comment (still says "the identity
module is the one consumer... outside the data layer") needs correcting regardless of this wave,
since it was already wrong before this wave existed.

**Who may write `platform.operators` matters as much as who may read it, and the first draft never
asked.** If `taskflow_app` — the ordinary application role every route runs as — held `INSERT` or
`UPDATE` on this table, any bug in any future route reachable by any authenticated user would be a
path to self-granting platform-operator access; the table would be one accidental `db.insert(...)`
call away from a privilege-escalation bug with no operator-side control at all. `taskflow_app` gets
`SELECT` only (needed for `isPlatformOperator` itself). No role reachable from application code
gets `INSERT`/`UPDATE`/`DELETE` — rows are written exactly the way §7's decision 7 already describes
the first operator being bootstrapped: by migration, or by a one-off script connected as
`taskflow_migrator` (`docker/postgres/init/02-roles.sql`'s existing migration-only role), never by
a route. This is stricter than every other cross-tenant role in this codebase (`taskflow_audit`,
`taskflow_backlinks`, `taskflow_notification_sweep` all still write, just narrowly) because this
table's entire purpose is deciding who gets to bypass tenant isolation — it is the one table in the
system where "no application code can write this, ever" is the correct answer, not merely the
cautious one.

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

**One route deliberately does not go through this builder at all.** `platformAdmin.self.check`
(§3.6) exists so `apps/web` can decide whether to render a link to `/platform-admin` in the first
place — every non-operator who has ever logged in calls it, on every page load, to learn the answer
is "no." Routing it through `platformRoute` would mean every ordinary member re-authenticates with
step-up just to have the account menu decide not to show them a link — a real, avoidable dead-end
the first draft didn't notice it had created. `self.check` uses the existing `selfRoute` builder
instead: authenticated, no permission, no step-up, answers `{ isOperator: boolean }` for whoever
asks. That answer isn't sensitive on its own — a `false` tells a non-operator nothing they didn't
already know, and a `true` is exactly what `platformAdmin.orgs.list` etc. already assume the caller
can see once they reach it, still gated by their own `platformRoute` checks.

### 3.3 Making `identity.orgs.status` real

No migration needed for the column itself — `orgs_status_valid` already constrains it to exactly
`'active'`, `'suspended'`, `'deleted'` (§1.2, corrected). The gap was always enforcement, in
`apps/api/src/tenancy/resolve.ts` (⚠ human-review surface already, per CLAUDE.md — this file
decides the role every subsequent check is evaluated against, and this is exactly the kind of
change that belongs on that reviewer's desk): after `resolveOrgMembership` finds a real membership
row, check the org's `status` — and the two non-`'active'` values get different treatment, because
they mean different things:

- **`'suspended'`** does **not** collapse into the existing `NOT_A_MEMBER` outcome — that error
  already means something specific ("you were never in this org, or you were removed"), and
  reusing it for "the org itself is suspended" would tell a legitimately-still-a-member Owner the
  wrong thing about what happened and what to do next. New error, `ORG_SUSPENDED`, distinct
  message, same fail-closed shape.
- **`'deleted'`** collapses into `NOT_A_MEMBER`, deliberately. This wave adds no route that can
  ever produce this state (§2 — org deletion stays out of scope), so it is reachable only by a
  future phase or a direct database action, and when it happens the same cross-tenant-privacy
  argument `member.service.ts` already makes for `NOT_FOUND` applies identically: "that org used to
  exist" is exactly the kind of fact a former member should not get confirmed by an error message.
  This also means this wave's enforcement code is already correct for the soft-delete phase §7.1
  anticipates, with nothing to revisit when that phase adds the route that actually sets it.

### 3.4 Self-serve creation guardrails

`org.service.ts::createOrg` gains one precondition, checked before the transaction opens:
`actor`'s `identity.users.emailVerifiedAt` must be non-null, or the mutation refuses with a
validation error telling the caller to verify their email first. This is a guard on infrastructure
that already exists (Phase 1's verification flow) — no new plumbing.

`middleware/rate-limit.ts`'s `OPERATION_RULES` gains an `orgs.create` entry: `{ limit: 3, windowMs:
24 * 60 * 60_000 }` (§7 decision 3), following the existing per-account-keyed pattern —
`auth.login`'s `{ limit: 5, windowMs: 15 * 60_000 }` is the nearest precedent in shape, not in
number, since guessing a password and abusing self-serve signup are different shapes of abuse.

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

**Two edge cases decided now rather than at review time** — §1.3's own undiscoverable workaround
could already have left an org in either shape before this wave exists:

- **The target holds `'guest'`.** `transferOwnership` refuses if `toUserId`'s current role is not
  `'admin'` or `'member'` — a guest becoming Owner in one step skips every intentional friction
  `isDirectlyAssignable`/`DIRECTLY_ASSIGNABLE_ROLES` already builds into how someone reaches a real
  role, and nothing about "transfer ownership" should be a shortcut around that. The error message
  says to promote them to `member` first.
- **The org already has two Owners.** `transferOwnership` doesn't need to know how many Owners
  exist — its two writes (promote target, demote caller) leave at least one Owner unconditionally
  regardless of the starting count, so a pre-existing extra Owner is simply still there afterward,
  not an error condition. A later cleanup story (an admin page listing an org's Owners, letting one
  demote the others) is real, named follow-up work the settings page doesn't have today — but it's
  not this route's job to detect or fix a shape it didn't create.

### 3.6 API surface — a new `apps/api/src/platform-admin` module

Mirrors the existing per-product layout, mounted in `apps/api/src/router.ts` as a top-level
`platformAdmin` namespace. Every route except one is `platformRoute` (§3.2):

- `platformAdmin.self.check` — `selfRoute`, not `platformRoute` (§3.2's own correction). No input,
  returns `{ isOperator: boolean }`.
- `platformAdmin.orgs.list` — paginated (`ai/phase-11.5-people.md` §7's own open pagination
  question for `people.directory.list` applies identically here, at platform scale it should
  default to yes):
  `{ orgId, name, slug, status, memberCount, createdAt }` per row. **Not `withGlobalScope`** — see
  §3.7, which is the actual mechanism this and the next bullet need.
- `platformAdmin.orgs.suspend` / `.reactivate` — writes `identity.orgs.status`, emits an event
  (§4), targets one org by id. Same §3.7 mechanism.
- `platformAdmin.users.list` — read-only in this wave (§2): `{ userId, email, emailVerifiedAt,
status, orgCount, createdAt }`, **via `withGlobalScope`, correctly this time** — `identity.users`
  carries no RLS at all (verified: no `ENABLE ROW LEVEL SECURITY` on it anywhere in the migration
  history), the same property that lets login resolve any email to an account before any org is
  known. This asymmetry between `orgs.*` and `users.list` is real and worth stating plainly rather
  than smoothing over: one reads a table RLS was built to protect and needs a role designed for
  that; the other reads a table that was never tenant-scoped to begin with.
- `platformAdmin.flags.list` / `.set` — thin wrapper over a new persistence layer, not the existing
  `packages/feature-flags` evaluator alone (§3.8 — the evaluator has no store today; this wave adds
  one).

### 3.7 A dedicated cross-tenant role for the org directory, not `withGlobalScope`

`identity.orgs` has `FORCE ROW LEVEL SECURITY` (migration 0004) with `orgs_tenant_isolation`
(`USING`/`WITH CHECK` both `id = current_setting('app.org_id')`) and the permissive `orgs_self_read`
(`app.user_id`-keyed). `withGlobalScope` clears **both** session variables — every one of
`platformAdmin.orgs.*`'s queries would run with neither variable set, which every policy above
evaluates to false. The read would silently return an empty list; the write would be refused by
`WITH CHECK`, not accepted and then invisible — a `platformAdmin.orgs.suspend` call would at least
fail loudly, but `orgs.list` returning `[]` for an operator looking at a real system with real orgs
is the quiet failure, and it's the one a manual smoke test could easily misread as "no orgs exist
yet" rather than "the query is broken."

This wave adds a fifth cross-tenant consumer role, following the exact pattern
`docker/postgres/init/02-roles.sql` already establishes for `taskflow_audit`, `taskflow_realtime`,
`taskflow_notification_sweep`, and `taskflow_backlinks` — every one of them `NOBYPASSRLS`, reaching
across tenants only through policies that explicitly name them, never through a superuser
shortcut:

```sql
CREATE ROLE taskflow_platform_admin WITH LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS;
```

New permissive policies, additive to the existing tenant-isolation ones (permissive policies OR
together, the same property migration 0004 already documents for `orgs_self_read`):

```sql
CREATE POLICY orgs_platform_admin_read ON identity.orgs
  FOR SELECT TO taskflow_platform_admin USING (true);

CREATE POLICY orgs_platform_admin_status_write ON identity.orgs
  FOR UPDATE TO taskflow_platform_admin
  USING (true) WITH CHECK (true);
```

The write policy is intentionally as wide as `UPDATE` gets — `WITH CHECK (true)` — because this
role should not be able to write anything the **application code** running as it doesn't already
constrain to `status` alone; §6's tests need to prove the service only ever sets `status` (never
`name`, `slug`, or anything else) through this connection, the same "the code is the real boundary,
the grant is the outer one" relationship `taskflow_backlinks`' column-level grant already has with
`docs.page_versions`. A `memberCount` column in `platformAdmin.orgs.list`'s output also needs
`identity.memberships` readable by this role — a parallel `SELECT`-only policy, scoped the same
way, since counting members is a read the console needs and nothing about it should imply write
access to membership rows.

A new `packages/db/src/platform-admin.ts` (mirroring `tenants.ts`'s existing shape for
`withGlobalScope`-adjacent, narrowly-scoped functions) exports `withPlatformAdminScope`, connecting
as `taskflow_platform_admin` on a **different connection pool** — not a different session-variable
state on the same one — the same architectural shape `initializeAuditDatabase`/`withAuditScope`
already use for the audit writer.

### 3.8 Feature flag overrides need a real table — the evaluator's `perOrg` support has no store

`packages/feature-flags/src/evaluator.ts` resolves an org override as its **highest**-precedence
source (`FlagContext.orgOverrides`, checked before environment and the registry default) and
already models per-flag `perOrg: true` opt-in — but `orgOverrides` is an input the evaluator
expects some caller to load; nothing in the package persists a set override anywhere. The first
draft's claim that flags "stay global, matching how `packages/feature-flags` already works" was
backwards: the capability for per-org targeting already exists and is simply unused, not absent.

This wave adds the missing store, deliberately narrow — a single **global** override table, no
per-org row shape yet:

```sql
CREATE TABLE platform.flag_overrides (
  flag_name   text        PRIMARY KEY,
  value       boolean     NOT NULL,
  set_by      uuid        NOT NULL REFERENCES identity.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

`platformAdmin.flags.set` writes a row here (or deletes it, to fall back to the
environment/default precedence); `platformAdmin.flags.list` reads all of them plus the registry
(`FLAGS`) to show every flag's current resolved value and source. **BUILT — 2026-08-09.** The
store now feeds a live evaluator: `apps/api/src/platform-admin/flag-evaluator.ts` merges
`platform.flag_overrides` into `FeatureFlags`' env tier (TTL-cached, single-flight, per the
runbook's own proposal), `platformAdmin.flags.list` resolves every row through the real
evaluator instead of the inline `override ?? default` it used to reimplement, and a
`flags.snapshot` selfRoute serves the resolved snapshot to the client bootstrap — the first real
`FeatureFlags.evaluate()` consumer. Still open by design: the evaluator's `orgOverrides` context
parameter (per-org targeting) goes unused, because there is no per-org row shape yet — a genuine
per-org targeting UI is real, valuable, out-of-scope follow-up work, not a capability this wave
discovered didn't exist.

### 3.9 Suspension is enforced at request time only, and that has two real consequences

§3.3's check lives inside `resolveOrgMembership`, which is not `resolve.ts`'s private concern —
`apps/realtime/src/rooms.ts` and `apps/collab/src/authorize.ts` both import and call the exact
same function, at room-join and page-authorize time respectively (confirmed by grep, not assumed).
So suspending an org through this wave's console already, for free, refuses every **new** room
join and every **new** collab authorization the moment it ships — no Phase 4 or Phase 6 code needs
to change.

**What "at request time" doesn't reach: sockets already in a room.** CLAUDE.md's own realtime
notes already establish that rooms do not survive a reconnect — the corollary is that a member who
was already connected and already joined a board's room before their org was suspended keeps
receiving that room's broadcasts until they disconnect or the socket naturally re-joins, because
nothing re-runs `resolveOrgMembership` for a room someone is already sitting in. This wave accepts
that lag for its first cut rather than building an active-disconnect mechanism (the gateway would
need to enumerate every room a suspended org's members hold across every socket and force-close
them — real work with its own failure modes) — named here explicitly as a decision, not a gap
nobody noticed: a suspended org's live collaborators can keep seeing board/doc activity for the
remainder of their current connection.

**What "at request time" doesn't reach, the other direction: nothing with no request at all.**
`apps/api/src/platform/due-reminders.ts`, `digest.ts`, `notification-mail.ts`, and
`notification-push.ts` all run as cross-tenant sweeps (the `taskflow_notification_sweep` role) with
no per-request org resolution to intercept — a suspended org's members can keep receiving
due-date reminders, digests, and push notifications exactly as if nothing changed, because none of
that code has ever had a reason to ask about org status before now. This wave's recommendation:
each of those four sweeps gains one additional join/filter, excluding cards, digests, and
notifications belonging to a non-`'active'` org — a small, explicitly-scoped change to Phase 9's
existing code, not something this wave's own migration or schema needs to touch. **BUILT —
2026-08-09, migration 0037.** The four delivery paths (the due-reminder cards scan, the digest's
pending-email collection, the push drain, and the projection's immediate-email decision) each join
`identity.orgs.status = 'active'`; `taskflow_notification_sweep` and `taskflow_audit` each gained
a column-limited `(id, status)` read of `identity.orgs` with its own permissive policy,
following 0035's `orgs_platform_admin_read` shape. A delivery row written before suspension stays
`pending` and flows again on reactivation. Proven by `wave2.sweep.test.ts`'s §3.9 suite against a
real database as both real roles.

### 3.10 Web UI surface

- **`/platform-admin`** (new top-level route tree in `apps/web/src/router.tsx`, entirely outside
  the org-scoped shell — no sidebar, no org switcher, because none of it is org-scoped): calls
  `platformAdmin.self.check` to decide whether to render a link from the account menu at all, and
  otherwise behaves like every other permission boundary in this codebase — a non-operator who
  navigates there directly gets the ordinary `ErrorView` FORBIDDEN, not a fake 404 (§3.2).
  - **Orgs tab**: searchable list, suspend/reactivate action with confirmation + step-up.
  - **Users tab**: searchable, read-only list (§2).
  - **Flags tab**: existing flag catalog, toggle per flag, backed by the new global override table
    (§3.8) — no per-org targeting UI yet, though the evaluator already supports it.
  - **Audit tab** — this wave's own operator-audit log (§4's `platform.operator_audit_log`, §7
    decision 2's option (c)). Reuses `Section`/`SkeletonRows`/`Empty` from `components/primitives.tsx`
    exactly as `admin/audit-page.tsx` already does for its org-scoped equivalent, rather than
    inventing new list chrome for what is structurally the same kind of page. This tab exists
    because decision 2 chose to write a global chain in the first place — recording every operator
    action somewhere nobody can ever read is barely more accountable than not recording it.
- **`admin/settings-page.tsx`** gains the Transfer Ownership action (§3.5). Nothing else on that
  page changes.

## 4. Event catalog

Four new events, `<resource>.<past_tense_verb>`, guardrail 11 applies with no exception — every one
emitted inside the mutation's own transaction:

- **`platform.org_suspended`** / **`platform.org_reactivated`** — `{ orgId, operatorUserId }`.
- **`member.ownership_transferred`** — `{ orgId, fromUserId, toUserId, fromNewRole }`, its own event
  rather than two generic `memberRoleChanged` events, for the identical reason
  `ai/phase-11.5-people.md` §3.6 gives for `reporting_line.changed`: a structural, sensitive fact
  deserves to be independently greppable in the audit log rather than requiring a reader to
  reconstruct "these two role changes were actually one handoff" from two unrelated-looking rows.
- **`platform.operator_granted`** — emitted by whatever inserts a `platform.operators` row. Wave 1
  ships with no self-service route for this (§7 decision 7), so in practice this event's only producer
  is a migration/seed script — still worth a real event definition rather than an unaudited manual
  `INSERT`, because "who has platform-operator access and since when" is exactly the kind of
  question this system's audit log exists to answer.

**Audit routing is decided: both** (§7 decision 2, option (c)). `platform.org_suspended` and
`platform.org_reactivated` write into the target org's own `audit.audit_log` chain, using its real
`orgId`, through the same `withAuditScope`/trigger mechanism every other org-scoped mutation
already uses — an Owner sees "a platform operator suspended this org" in their own audit history
with no operator access required, the same way any other action they didn't personally take
already appears there. Every operator action, org-scoped or not (including read-only
`platformAdmin.orgs.list`/`users.list` calls — an operator's own accountability record should not
depend on which orgs happen to still exist to attribute a read to), additionally writes into a new,
separately-chained `platform.operator_audit_log`:

```sql
CREATE TABLE platform.operator_audit_log (
  seq         bigint      GENERATED ALWAYS AS IDENTITY,
  operator_id uuid        NOT NULL REFERENCES identity.users (id),
  action      text        NOT NULL,        -- 'orgs.suspend', 'orgs.list', 'flags.set', ...
  target      jsonb,                       -- { orgId } or { userId }, or null for a bare list call
  prev_hash   bytea       NOT NULL,
  hash        bytea       NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
```

Same hash-chain shape `audit.audit_log` already established (Phase 2: a trigger under a
chain-head lock assigns `seq`/`prev_hash`/`hash`; the app role never chooses its own position or
digest), globally chained rather than per-org since there is exactly one operator population to
account for, not one per tenant. `packages/db/src/audit-chain.ts`'s existing verifier generalizes
to a second chain rather than needing a second implementation — nothing about the hash-chaining
logic is org-specific, only the head lock's scope changes, from per-org to a single global lock.

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
- `platformAdmin.orgs.list` returns every real org, not an empty list, proven against real
  Postgres as `taskflow_platform_admin` — the exact class of failure (§3.7) that would pass a type
  check and a superficial review and only fail against a real database.
- Every `platformAdmin.*` call, whether it changes anything or not, produces a row in
  `platform.operator_audit_log`; every org-scoped one additionally produces a row in that org's own
  `audit.audit_log`.
- `pnpm --filter @taskflow/db migrate:verify` passes; guardrail selftest passes with the extended
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
for `closed` on a channel's `can()` target). A test proving `taskflow_app` cannot `INSERT` into
`platform.operators` (a grant-level assertion, run against real Postgres, the same class of test
`client.test.ts` already runs for other role/grant boundaries) — the one control in this document
with no code-level fallback if the grant is ever widened by accident. A test proving
`platformAdmin.orgs.list` returns real rows connected as `taskflow_platform_admin` specifically
(§3.7, §5) rather than only being exercised in a way that would hide the zero-rows failure.

## 7. Decisions

Answered 2026-08-08. Numbering kept stable from the draft (referenced throughout §§1–6 above) even
though these are no longer open.

1. **Flat operator flag vs. scoped operator roles from Wave 1** (§3.1). **Decided: flat flag.**
   Revisit only if a second operator with narrower needs (e.g. read-only support access) actually
   shows up — not before, per CLAUDE.md's own stance against building a scoping mechanism for a
   table with, realistically, one or two rows.
2. **Where platform-operator actions get audited** (§4). **Decided: (c), both** — the target org's
   own chain for org-scoped actions, plus a new global `platform.operator_audit_log` for every
   operator action, including cross-org reads. Flagged as the single costliest-to-reverse decision
   in the draft; it's now built into §4's schema and §3.10's Audit tab rather than left open.
3. **The `orgs.create` rate-limit number** (§3.4). **Decided: 3 per account per 24 hours**, as
   proposed — generous for a legitimate person setting up a company and a personal workspace in the
   same day, cheap to raise later, expensive to have shipped unset.
4. **`ORG_SUSPENDED` as a new error code vs. reusing `NOT_A_MEMBER`** (§3.3). **Decided: new
   code.** `packages/contracts/errors.ts` gains it, and every client-side error-message table that
   switches on error codes needs the new case added — a grep-for-`NOT_A_MEMBER`-style sweep at
   implementation time, not a design question anymore.
5. **User suspension** (§2). **Decided: deferred** to a later Phase 12 wave alongside device
   inventory / impossible-travel — a materially bigger capability than org suspension, with no
   natural home in an "orgs and ownership" wave. This wave's console can freeze an org; it cannot
   freeze a person.
6. **Migration numbering.** **Decided: claim the next number actually free on `main` at merge
   time** — `0032` as of this writing, but not hardcoded above for the same reason
   `ai/phase-11.5-people.md` §7.4 didn't hardcode its own.
7. **Bootstrapping the first operator.** **Decided: migration or one-off script, no self-service
   route in Wave 1** — reinforced by §3.1's grant-surface correction, which goes further than the
   original recommendation: not merely "no UI yet," but no application-reachable write path to
   `platform.operators` at all. A self-service grant/revoke UI, if ever built, is real future work
   that needs its own grant-surface design, not a Wave 2 checkbox on this table.

## 8. Sequencing and cost

Depends on Phase 1 (email verification — complete), Phase 2 (memberships, role matrix — complete),
and `packages/feature-flags` (Phase 0B — complete). Independent of Phases 8–11; does not need to
wait behind any of them, the same reasoning `ai/phase-11.5-people.md` §8 already applies to its own
position in the numbered-but-unordered back half of the roadmap.

**Phase 7 is the one exception, and the dependency runs one way.** This phase does not need
anything from Phase 7. Phase 7 needs one thing from this phase — see §9.

New surface, sized against Phase 12's overall 6-week estimate: two new tables
(`platform.operators`, `platform.flag_overrides`), one new hash-chained table
(`platform.operator_audit_log`, reusing the existing chain trigger/verifier mechanism rather than
inventing a second one), one new Postgres role with its own RLS policies
(`taskflow_platform_admin`, §3.7 — the piece the draft got wrong and this revision replaces), one
new route kind (`platformRoute`), one new API module, one extended (not new) ESLint carve-out with
its `guardrail-selftest` case, four new events, one new top-level web route tree with four tabs,
and one new entry on CLAUDE.md's human-review list. Larger than the draft's original estimate once
§3.7's role/policy work and §4's global audit chain are counted honestly rather than assumed free
via `withGlobalScope` — **estimate: 3–4 weeks**, still leaving the rest of Phase 12's 6-week line
(retention, DSAR, crypto-shred, TOTP, OAuth, device inventory, SCIM/SAML, SOC 2) as later waves of
the same phase, unsized here.

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

**What Phase 7 needs to do about it, when it's scoped.** Treat `platform.org_suspended` (§4) as a
subscribed event, not an HTTP-layer concern: whatever holds the spend-cap state (§8.5) needs a
fast, request-context-independent "is this org frozen" check consulted immediately before any
outbound Twilio API call — the same shape as the spend cap check itself, run alongside it rather
than instead of it, since they answer different questions ("can this org afford this" vs. "is this
org allowed to do anything at all"). A stretch goal worth naming for whoever scopes Phase 7: also
pause the org's Twilio **subaccount** itself (Twilio's own subaccount-suspend API) on
`orgSuspended`, not only refuse the action on our side — a leaked or compromised org's Twilio
credentials otherwise remain independently usable directly against Twilio, bypassing this
application entirely, which the per-org-subaccount credential-compromise control (§8.5) already
implies matters. **BUILT — 2026-08-09.** The spend-gate's org-status check was already in place
(Phase 7 Wave 1); the subaccount pause now lands with the suspension itself:
`platformAdmin.orgs.suspend`/`.reactivate` call the telephony module's own `setSubaccountStatus`
(reused, not reimplemented — its `carrierUpdated: false` honesty on carrier failure carries
over), best-effort and last, so a missing subaccount or a carrier outage can never fail the
operator's action. The freeze is recorded in the org's own audit chain via the
`subaccount.status_changed` event, and proven by the platform-admin suite's §9 tests.

**Sequencing.** This document's own position (§8) is that this wave doesn't need to wait on
anything past Phase 2. Phase 7 is the reverse case: given §8.5 already calls toll fraud the most
expensive failure mode in the system, shipping Phase 7 before this wave exists means shipping it
with automatic spend-cap cutoffs but no operator-initiated kill switch for the org itself — not
wrong, but worth being a deliberate choice rather than a gap discovered during a real incident. If
Phase 7 is scoped first for other reasons, it should stand up its own minimal org-freeze primitive
and treat adopting this wave's `platform.org_suspended` event later as a straightforward swap, the
same forward-compatible shape §5's provider-interface pattern uses elsewhere in this codebase —
not a reason to ship Phase 7 with no equivalent control at all.
