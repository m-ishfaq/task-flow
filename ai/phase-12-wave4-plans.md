# Phase 12, Wave 4 — Plan catalog, entitlements & usage billing

**Status: SHIPPED — the spec header lags, per CLAUDE.md's own "status marker is a claim, not a
fact" discipline (also caught stale on Phase 11's own header, the same day, by the same check).**
`packages/db/migrations/0062_plan_catalog.up.sql`/`0063_org_plan_fk.up.sql`, `apps/api/src/
billing/entitlement-resolver.ts` (the four-tier resolution this section describes),
`apps/api/src/platform-admin/plan-catalog.service.ts`, and `apps/web/src/features/
platform-admin/plans-tab.tsx` (the operator console's plan editor, including the per-plan
feature checkbox dialog this section names) are all real and wired in. `packages/seed/src/
modules/billing.catalog.ts` seeds four real tiers (free/starter/pro/business) through the
console's own service functions rather than raw inserts, exactly as §1 below argues for. Left
corrected in place rather than silently rewritten.

**Written 2026-08-13, still DRAFT below.**

Wave 3 shipped billing STATE — is this org trialing, paying, lapsed. It never shipped a
notion of WHAT an org is paying for. This wave adds the catalog, makes it operator-editable
from `/platform-admin` rather than from the Stripe dashboard, wires plan entitlements into
the per-org feature-flag tier that has existed and been empty since Phase 0, and closes the
one real cost leak in the product: telephony usage the platform pays for and never bills.

Prerequisite reading: [phase-12-wave3.md](phase-12-wave3.md) (the billing spine this
extends), [phase-12-admin.md](phase-12-admin.md) §3.7 (the operator console and its
dedicated role), [phase-7-voice.md](phase-7-voice.md) §7.2 (the spend gate this wave reads
from and must not touch).

---

## 1. What this wave found

Five things, found by reading the code rather than the specs.

**Plans are barely modelled.** `identity.orgs.plan_id` is a free `text` column with no
foreign key and no reader anywhere in the product. The entire plan surface is one hardcoded
literal — `billing.createCheckoutSession` takes `planId: z.literal('pro')`
(`apps/api/src/billing/router.ts`) and `deps.planPriceIds` maps that one string to
`BILLING_STRIPE_PRICE_ID_PRO`. There is no catalog table, no second tier, and no way to
change a price without a redeploy.

**`StripePaymentProvider` cannot create anything.** It has `ensureCustomer`,
`createCheckoutSession`, `createPortalSession` and `parseWebhookEvent`. Products and Prices
are assumed to already exist, made by hand in Stripe's dashboard. That assumption is the
thing this wave removes.

**The per-org feature-flag tier exists and is empty.** `FeatureFlags.evaluate()` resolves
per-org override → environment → registry default (`packages/feature-flags/src/evaluator.ts`),
six of the eight flags are declared `perOrg: true`, and **nothing ever populates
`orgOverrides`**. `platform-admin/flag-evaluator.ts` merges the global overrides into the
ENVIRONMENT tier instead, and `packages/db/src/schema/platform.ts` states outright that the
org tier "stays unused". This wave is that tier's first consumer. It is not a new mechanism —
it is the mechanism that was designed for exactly this and never wired up.

**The flag registry is stale, and this wave makes that load-bearing.** `chat`, `docs`,
`telephony`, `automation`, `publicApi` and `analytics` are all `stage: 'planned'` with
`defaultValue: false` in `packages/feature-flags/src/flags.ts`, while every one of those
modules has shipped. Today that is harmless because nothing consults them. The moment a plan
entitlement resolves through the registry, a stale `defaultValue` is a module that goes dark
for a tenant who is paying for it. **Fixing the registry is in scope for this wave, not a
follow-up** — see §3.4.

**Telephony costs the platform money and no org is ever charged.** `comms.spend_ledger`
already carries per-org, per-action `estimated_cents` and carrier-reconciled `actual_cents`;
`spendReport` already groups it by kind. `TELEPHONY_DEFAULT_SPEND_CAP_CENTS` exists to stop
one tenant bankrupting the deployment — it is a PROTECTION, not an invoice. There is no path
from that ledger to Stripe. Every call a tenant places is pure cost. The data to bill it has
been sitting there since Phase 7 Wave 1.

---

## 2. In scope, and what stays out

**In scope.**

- `billing.plans` and `billing.plan_prices` — a multi-tier catalog with monthly and annual
  prices, editable from the operator console.
- Stripe Product/Price creation and archival through `PaymentProvider`, so the Stripe
  dashboard is never opened to add or reprice a plan.
- Plan entitlements resolved into `FlagContext.orgOverrides`, plus the flag-registry
  correction that makes that safe.
- Plan-driven ceilings for the three caps that ALREADY have per-org tables and working
  gates: telephony spend, automation executions, TURN issuance.
- `billing.org_entitlements` — an operator override, per org, that outranks the plan.
- Trial → Free: a warning email before expiry, an automatic move to the default plan at
  expiry, and the corresponding change to what `billing_status = 'canceled'` means.
- Telephony usage billing: an included allowance, a markup percentage, threshold warnings,
  and a period-close job that pushes an overage invoice item to Stripe.
- A Plans tab in `/platform-admin`, and a plan/entitlement section on the org drill-down.

**Explicitly out.**

- **Counting limits** — max members, max projects, storage quota. None of these has a per-org
  table, a counter, or an enforcement point today; each needs all three plus an answer for
  "already over". Deferred deliberately, and §3.7 explains what that deferral does to the
  downgrade problem.
- **Per-tenant mail infrastructure.** Mail stays deployment-wide: one relay, one sender. What
  changes is that a billing email says which org it concerns. Sending from a tenant's own
  verified domain is DNS/SPF/DKIM work and is its own phase.
- **Operator-managed email templates.** Confirmed as the wave after this one. The three
  billing emails this wave needs ship as code in `@taskflow/mail`, and move to the template
  store when it exists.
- **Partner/reseller commission.** "Commission" here means the platform's markup on tenant
  usage, not a cut paid to a referrer. A partner ledger shares nothing with this but the word.
- **Per-seat pricing.** Wave 3 deferred seats; this wave does not take that back up.
- **The seeder rewrite and the operator-is-an-org-owner fix.** Confirmed as the wave after.
  This wave only adds the seed module needed to make the catalog non-empty (§8).

---

## 3. Structural decisions

### 3.1 Four tiers, and the plan is a ceiling rather than a value

Entitlements and caps both resolve through the same chain, highest precedence first:

```
1. Operator override    billing.org_entitlements   — outranks everything, incl. the plan
2. Org's own value      comms.spend_policy etc.    — owner-set, bounded above by tier 3
3. Plan                 billing.plans              — the ceiling / the entitlement set
4. Deployment default   env                        — TELEPHONY_DEFAULT_SPEND_CAP_CENTS etc.
```

Tier 2/3/4 is not new — it is exactly the split telephony has used since Phase 7 Wave 1,
where `TELEPHONY_DEFAULT_SPEND_CAP_CENTS` is the fallback, `comms.spend_policy.cap_cents` is
the org's value, and `TELEPHONY_MAX_SPEND_CAP_CENTS` is a ceiling no self-service raise may
cross. This wave replaces that env ceiling with the org's plan. The security argument
survives intact: raising a cap is a legitimate Owner action, which is precisely why a
compromised Owner credential is a realistic route to toll fraud, and the ceiling is the one
bound a stolen credential cannot move.

**Tier 1 is new, and it costs something.** An operator override that outranks the plan means
the plan is no longer a guarantee — "every Pro org has Docs" becomes "every Pro org has Docs
unless someone decided otherwise". Three things pay for that:

- `reason` is `NOT NULL`. An override with no stated reason cannot be written.
- The console renders the SOURCE next to every resolved value: `Docs: on — operator override
(not from plan)`. A resolved entitlement that does not say where it came from is how "why
  does this Free org have Voice" becomes unanswerable.
- `expires_at` is nullable but offered in the UI, so a trial extension does not become
  permanent by being forgotten.

**Overrides are DELTAS, not replacements.** `features_add` and `features_remove` rather than
one `features` array. A full override array freezes that org at the feature set it had when
the override was written — add Analytics to Business six months later and the one org with an
override silently does not get it. Deltas compose with future plan changes; a replacement
quietly stops composing and nothing reports it.

### 3.2 The catalog: two tables, and one partial unique index does the grandfathering

```sql
billing.plans
  id                        text PRIMARY KEY        -- 'free' | 'pro' | 'business'
  name, description, sort_order, is_active
  is_default                boolean                 -- where trials land; exactly one
  stripe_product_id         text                    -- NULL for a plan with no paid price
  features                  text[]                  -- FlagName[], validated in the service
  telephony_cap_cents       bigint                  -- NULL = unlimited
  telephony_included_cents  bigint NOT NULL DEFAULT 0
  telephony_markup_pct      integer NOT NULL DEFAULT 0
  automation_runs_per_hour  integer
  turn_issuance_per_day     integer
  created_at, updated_at, updated_by

billing.plan_prices
  id                uuid PRIMARY KEY
  plan_id           text REFERENCES billing.plans (id)
  interval          text CHECK (interval IN ('month', 'year'))
  amount_cents      bigint CHECK (amount_cents >= 0)
  currency          text NOT NULL DEFAULT 'usd'
  stripe_price_id   text UNIQUE
  is_current        boolean NOT NULL
  archived_at       timestamptz
  created_at

CREATE UNIQUE INDEX plan_prices_current_key
  ON billing.plan_prices (plan_id, interval) WHERE is_current;
```

That partial unique index IS the grandfathering mechanism. Many rows per `(plan, interval)`,
exactly one current — enforced by the database rather than by a service that remembers to
clear the old flag. Repricing Pro from $29 to $39 archives the $29 row (`is_current = false`,
`archived_at` set), creates a $39 row, and touches no subscription: existing customers keep
billing against the archived Stripe Price, which Stripe honours indefinitely. New checkouts
resolve `is_current`. The console reports "3 orgs on a retired price" so the tail is visible
rather than forgotten.

`features` is a `text[]` validated against `FLAG_NAMES` in the service rather than by a CHECK
constraint, because the database cannot know the registry. The precedent is
`packages/seed/src/modules/platform.admin.ts`, which validates its override list against the
real registry for the same reason and says so: a flag renamed below the check's notice is a
row the evaluator silently ignores.

**`identity.orgs.plan_id` gains a foreign key to `billing.plans (id)`.** It has been free text
since 0059. The migration backfills every existing row to the default plan before adding the
constraint.

### 3.3 The grant trap this migration walks straight into

Migration 0059 declared, at lines 118–121:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;
```

So **every table a later migration creates in `billing` is fully writable by the application
role**, before that migration grants anything. A `billing.plans` whose migration carefully
grants `taskflow_app` SELECT only would be INSERT/UPDATE/DELETE-able by the app role anyway,
and the migration would read as if it were not.

This is migration 0036's lesson exactly — `ALTER DEFAULT PRIVILEGES ... IN SCHEMA platform`
made 0035's "SELECT only" grants on `platform.operators` weaker than what the database
already enforced, and it took explicit REVOKEs to close. It was found by a test against a
real database, not by reading the migration. **0062 must say what these tables must NOT have,
not only what they should**, and the §6 suite asserts it as the real roles.

Concretely: `taskflow_app` gets SELECT on `billing.plans` and `billing.plan_prices` (the
owner-facing plan picker has to read them) and nothing else. `taskflow_platform_admin` gets
INSERT/UPDATE. Nobody gets DELETE — a plan is archived, never removed, because
`identity.orgs.plan_id` and every historical `plan_prices` row references it.

Both tables are GLOBAL — no `org_id`, no RLS — like `platform.operators` and
`platform.flag_overrides`. They therefore need no entry in `check-migration-rls.mjs`'s
`RLS_EXEMPT` map, which only covers tables that HAVE an `org_id` and deliberately lack RLS.
`billing.org_entitlements` does have an `org_id` and DOES get ordinary RLS: an org may read
its own override (the billing page shows it), and only the platform-admin role writes it.

### 3.4 Entitlements resolve through the flag tier — and must never become authorization

Plan features land in `FlagContext.orgOverrides`, resolved by a new
`billing/entitlement-resolver.ts` that merges, in the §3.1 order, and caches per org with the
same TTL/single-flight shape `platform-admin/flag-evaluator.ts` already uses for the global
tier.

**Guardrail 7 says a feature flag gates product surface and never a security control.** This
wave puts a paid plan behind that mechanism, which makes the guardrail sharper, not looser:

- A plan check is a SECOND, INDEPENDENT gate that can only ever REMOVE access. It runs
  alongside `can()`, never instead of it.
- A user who lacks `page:read` still gets `FORBIDDEN`, regardless of plan. A user who has
  `page:read` on a Free org gets `PLAN_REQUIRED`. Neither answer can be reached by
  manipulating the other.
- `packages/policy` is not touched by this wave. If a change here appears to need one, the
  design is wrong.

**The registry correction.** Every shipped module's flag moves to `stage: 'launched'` and
`defaultValue: true`, and `telephonyLiveCredentials` keeps `perOrg: false` (it is release
plumbing that starts real spend, not a product surface — Phase 7 §8.5). A tenant whose plan
grants Docs must not have Docs decided by a `defaultValue` written when Docs did not exist.

### 3.5 Caps: three existing gates gain a new source for a number they already read

Telephony spend, automation executions per hour, and TURN issuances per day all already have
a per-org table, a working gate, and a deployment default. This wave changes **where the
number comes from**, and nothing else:

| Gate                   | Table it reads                 | Untouched                            |
| ---------------------- | ------------------------------ | ------------------------------------ |
| `checkOutboundAllowed` | `comms.spend_policy.cap_cents` | ⚠ human-review file — **not edited** |
| automation budget      | `platform.automation_budget`   | the claim/skip-locked logic          |
| `turn-gate.ts`         | `rtc.turn_issuance`            | ⚠ human-review file — **not edited** |

Both human-review surfaces (`apps/api/src/telephony`, `apps/api/src/rtc/turn-gate.ts`) are
deliberately **not modified**. The plan becomes a writer of the policy rows those gates read,
never a second gate and never a branch inside the existing one. A wave that "adds plan
awareness" by editing the spend gate would put a pricing concern inside the one file whose
entire job is refusing to spend money, and would need the full adversarial review for a
change that is genuinely a data question.

### 3.6 Trial → Free, and what `canceled` stops meaning

The flow, all of it in the existing worker sweep:

1. `BILLING_TRIAL_ENDING_WARNING_HOURS` (default 72) before `trial_ends_at`, the sweep emails
   the org OWNER: upgrade, or do nothing and land on Free. Recorded so it sends once.
2. At `trial_ends_at` with no subscription, the sweep sets `plan_id` to the default plan and
   `billing_status = 'active'`, and emails the owner immediately.
3. The org keeps every row it created. Modules its new plan does not include go dark —
   navigation hidden, routes answer `PLAN_REQUIRED`, data untouched. Upgrading restores them
   on the next entitlement-cache tick.

**This changes a security-relevant chokepoint and needs human review.** 0059 widened
`resolveOrgMembership` to refuse on `status = 'suspended'` OR `billing_status = 'canceled'`.
With Free as the floor, no billing state should lock a tenant out of their own data —
entitlements do that work now, per module, honestly. So:

- Free orgs are `billing_status = 'active'` with `plan_id = 'free'`. Not `canceled`.
- `canceled` survives in the CHECK as the TRANSIENT window between Stripe reporting a
  subscription deleted and the next sweep tick moving the org to the default plan.
- `resolveOrgMembership` **stops refusing on `billing_status`** and keeps refusing on
  `status = 'suspended'`. Refusing on a transient state would lock an org out for the
  duration of the sweep's own latency — a lockout whose length is a polling interval.
- Wave 3's central argument is untouched: `status` and `billing_status` remain two columns
  with two writers, so an automated billing recovery still cannot undo an operator's manual
  suspension.

### 3.7 "Over limit" is two different states, and only one can happen this wave

The distinction matters, and I got it wrong in conversation before pinning the scope down:

**Feature over-limit happens constantly, and is the normal case.** An org spends fourteen days
on trial entitlements building 500 doc pages, does not convert, and lands on Free with no
Docs. That is not an edge case — it is every non-converting trial, on day 15, by design. It
also arrives from Stripe's own customer portal (which `createPortalSession` hands the owner,
and where a downgrade happens without our involvement — we learn by webhook, after) and from
an operator lowering a plan's entitlements with orgs already on it. Handling: the module goes
dark, the data is preserved, upgrading restores it. No counting, no choosing which rows
survive, no read-only mode.

**Counting over-limit cannot happen this wave, because no counting limit exists.** Members,
projects and storage have no ceiling to exceed. So the "40 members downgraded to a 20 limit"
problem is genuinely not reachable — the instinct that it should not hit was right, for this
scope. It becomes live the day counting limits ship, and the answer decided for that day is
freeze-and-block: existing rows keep working, the ADDITION is refused, nothing is destroyed.
The check must be "would this addition exceed", never "is the count over", or an org that
arrives over the line can never get back under it.

**The seeder must respect this** (next wave, noted here so it is not rediscovered): profiles
seed within their org's plan, and a profile that plans more than its plan allows fails the
run. A fixture that quietly exceeds a limit means the enforcement is never exercised in
development.

### 3.8 Usage billing — the platform's margin, computed from a ledger that already exists

Three numbers on the plan: `telephony_included_cents`, `telephony_markup_pct`,
`telephony_cap_cents`.

```
billable = max(0, (Σ COALESCE(actual_cents, estimated_cents) × (1 + markup/100)) - included)
```

The sum is `sumWithFallback` from `packages/db/expressions.ts` — unchanged, and used for the
identical reason the spend gate uses it: a ledger row the carrier has not billed yet has a
NULL `actual_cents`, and `SUM(actual_cents)` alone counts every in-flight action as free.

A new period-close job in `apps/worker` runs it per org at the billing period boundary and
pushes ONE Stripe invoice item. Not a per-call usage record: Stripe rate-limits usage
reporting, a per-action push makes the invoice unreadable, and a failed push mid-period is
far harder to reconcile than a single idempotent one keyed on `(org, period)`.

Behaviour at the edges, all of it reusing what exists:

- Crossing `included` bills the overage and **changes nothing about access**. Calls keep
  working.
- 80% and 100% of `telephony_cap_cents` email the owner.
- The cap itself remains the hard stop, refused by `checkOutboundAllowed` exactly as today.
  Markup and overage are billing-side arithmetic and are never a gate.

**`comms.spend_ledger` is the source of truth for what the tenant is charged, and it records
what the platform PAID.** Both facts live in one row already. What is added is a read, at
period close — no new column on the ledger, and no second ledger to drift from it.

### 3.9 Stripe writes: order of operations, and which direction to fail in

`PaymentProvider` gains four methods, implemented by both `StripePaymentProvider` and
`FakePaymentProvider`:

```
createProduct({ name, description })                    -> { productId }
createPrice({ productId, amountCents, currency, interval }) -> { priceId }
archivePrice(priceId)
archiveProduct(productId)
```

`FakePaymentProvider` implements all four in memory, so the whole console works end to end
with `PAYMENTS_PROVIDER=fake` and no Stripe account — the same convention
`FakeTelephonyProvider` establishes, and the reason a developer never needs a carrier or a
processor to run this app.

**Stripe first, then our row, in that order.** Creating a plan is one database write and up to
three Stripe calls. If our transaction fails after Stripe succeeded, we have orphaned a Stripe
Product that nothing references — inert. If our row is written first and Stripe then fails, we
have a catalog row with a null `stripe_price_id`, which is a plan an owner can click Upgrade
on and a checkout that cannot be created. Fail in the direction that is inert.

The Free plan has `stripe_product_id IS NULL` and no `plan_prices` rows at all. Checkout is
never reached for it; moving to Free is a subscription cancellation plus a `plan_id` write.

---

## 4. Event catalog

Global events (no org) travel the in-process `EventBus` and land in the operator audit chain,
never `platform.outbox` — whose RLS policy keys on `app.org_id`, which a catalog change does
not have. That is `platform-admin/events.ts`'s existing rule, not a new one.

| Event                          | Scope  | Carries                                                           |
| ------------------------------ | ------ | ----------------------------------------------------------------- |
| `plan.created`                 | global | plan id, name, prices                                             |
| `plan.updated`                 | global | plan id, changed fields                                           |
| `plan.price_added`             | global | plan id, interval, old/new amount, orgs left on the retired price |
| `plan.archived`                | global | plan id, orgs still on it                                         |
| `org.plan_changed`             | org    | from, to, actor (owner \| operator \| sweep)                      |
| `org.entitlement_override_set` | org    | the delta, reason, expiry                                         |
| `org.trial_ending`             | org    | hours remaining                                                   |
| `org.trial_expired`            | org    | plan landed on                                                    |
| `org.usage_overage_billed`     | org    | period, cents billed, markup applied                              |

Every `platformAdmin.plans.*` call also lands in the hash-chained operator audit log, reads
included — Wave 1's rule that every operator call is recorded, without exception.

---

## 5. Web UI surface

**`/platform-admin` → Plans (new tab).** List with tier, prices, feature set, and a live count
of orgs on each. Create/edit/archive. The edit form shows the Stripe consequence before
saving — "this creates a new $39 Price; 12 orgs stay on $29" — because a console that hides
which button charges real customers is a console that will eventually charge them by accident.

**`/platform-admin` → org drill-down (new).** The clickable-name ask, scoped to billing for
this wave: plan, resolved entitlements with the SOURCE of each, usage this period against the
included allowance, and the override editor. The fuller directory drill-down (members,
sessions, projects) is the console wave, not this one.

**Owner-facing `/settings/billing`.** Plan picker driven by the catalog rather than one
hardcoded button, current usage against allowance, and an honest banner when a module is dark:
"Docs is not included in Free — your 500 pages are kept and return when you upgrade."

---

## 6. Cross-cutting obligations

- **Migrations 0062 (catalog + entitlements) and 0063 (backfill + `plan_id` FK)**, paired
  up/down, expand-migrate-contract. 0062 must carry the explicit REVOKEs §3.3 describes.
- **Grants asserted as the real roles against a real database**, per the standing lesson from
  Phases 4, 6 and 12 Wave 1: the database does not read your comments. Specifically that
  `taskflow_app` CANNOT write `billing.plans` despite the schema's default privileges.
- **An entitlement-resolution matrix test** — the four tiers × present/absent at each, proving
  precedence and that an expired override falls back to the plan rather than to nothing.
- **A parity test that `can()` is unreachable from plan state**: a Free org's Owner still gets
  `FORBIDDEN` (not `PLAN_REQUIRED`) for something their ROLE forbids, and vice versa.
- **Human review (PLAN.md §2.2):** the `resolveOrgMembership` change (§3.6), the entitlement
  resolver (§3.4), and the Stripe write path. `apps/api/src/telephony` and
  `apps/api/src/rtc/turn-gate.ts` are deliberately not edited — if a diff touches either, the
  design in §3.5 was not followed.
- **Env:** adds `BILLING_TRIAL_ENDING_WARNING_HOURS` (72) and `BILLING_DEFAULT_PLAN_ID`
  (`free`). **Removes `BILLING_STRIPE_PRICE_ID_PRO`**, which means `buildBillingDeps`' boot
  check changes shape — a `stripe` deployment now requires a catalog with at least one current
  price instead of an env var. All four `KNOWN_VARIABLES` sets and both env files need the
  same edit, or a correctly-configured process refuses to boot naming a variable spelled
  correctly (the `DATABASE_SEARCH_URL` lesson).

---

## 7. Decisions

1. **Plan is a ceiling, not a value.** Rejected: plan sets the value directly. The DEFAULT/MAX
   split already exists in telephony and already carries the toll-fraud argument; a second
   pattern for the same shape means two places to reason about and one of them will drift.
2. **Operator override outranks the plan.** Rejected: custom deals become new plan rows. That
   works until the catalog is thirty rows of one-customer tiers, and it makes "what does Pro
   include" unanswerable.
3. **Overrides are deltas.** Rejected: a full replacement array. It silently stops composing
   with future plan changes, and nothing reports that it has.
4. **Grandfather on reprice.** Rejected: migrate everyone at renewal. Editing a number in a
   console should not change what an existing customer's card is charged.
5. **Entitlements ride the existing flag tier.** Rejected: a parallel entitlement checker.
   The tier exists, is documented, is tested, and is empty.
6. **The flag registry is corrected in this wave.** Rejected: a follow-up. A stale
   `defaultValue: false` on a shipped module is a paying tenant's module going dark.
7. **No counting limits.** Rejected: shipping member/project/storage caps now. Each needs a
   counter that cannot drift plus an "already over" answer, and none of the three has a table
   today. §3.7 records the decision for when they land.
8. **Free is `active`, not `canceled`; `resolveOrgMembership` stops consulting
   `billing_status`.** Rejected: keeping the refusal. It would lock a tenant out for the
   duration of a polling interval, over a state that means "about to be on Free".
9. **Usage is billed at period close, one invoice item.** Rejected: per-call usage records.
   Rate limits, an unreadable invoice, and a mid-period failure that is far harder to
   reconcile than one idempotent push.
10. **The spend gate and the TURN gate are not edited.** Rejected: teaching them about plans.
    They already read a per-org number; the plan becomes a writer of that number. This keeps
    a pricing concern out of the two files whose job is refusing to spend money.

---

## 8. Sequencing

**Slice 1 — the catalog, no enforcement.** Migration 0062/0063, `billing.plans` +
`plan_prices` + `org_entitlements`, the four new `PaymentProvider` methods on both
implementations, `platformAdmin.plans.*`, the Plans tab. Acceptance: a plan can be created,
repriced and archived from the console against `PAYMENTS_PROVIDER=fake` with no Stripe
account, and `taskflow_app` provably cannot write either table.

**Slice 2 — entitlements.** The registry correction, `entitlement-resolver.ts`, the
`orgOverrides` wiring, `PLAN_REQUIRED` on the gated routers, the dark-module UI. Acceptance:
moving an org between plans in the console turns modules on and off, and the `can()` parity
test passes.

**Slice 3 — caps and the trial flow.** Plan-driven writes to the three policy tables, the
trial-ending email, the trial → Free transition, the `resolveOrgMembership` change. Acceptance:
a trial expiring in a seeded database lands on Free, emails the owner, darkens the right
modules, and keeps every row.

**Slice 4 — usage billing.** The period-close job, the markup arithmetic, threshold emails,
the Stripe invoice item, the usage panel on both billing surfaces. Acceptance: a seeded org
with telephony spend past its allowance produces exactly one invoice item with the plan's
markup applied, and the existing spend gate's behaviour is bit-for-bit unchanged.

Slices 1 and 2 unblock the seeder rewrite and the console drill-downs. Slices 3 and 4 can
follow without blocking either.
