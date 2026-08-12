# Phase 12, Wave 3 — Billing & org lifecycle

**Status: DRAFT, not yet approved for build.** Written 2026-08-12, at the project owner's request,
after a design conversation about a real point of confusion: with Wave 1 and Wave 2 both shipped,
org role and platform-operator access are already fully decoupled in code — but nothing in the
system says *when* an org should lose access for non-payment, and that gap is what made "an org
owner" and "the system admin" feel like the same thing in practice. This wave closes that gap.

Parent: [PLAN.md](../PLAN.md) §13 (Roadmap, row 12). Siblings:
[phase-12-admin.md](phase-12-admin.md) (Wave 1 — org governance & platform admin, shipped),
[phase-12-wave2.md](phase-12-wave2.md) (Wave 2 — identity extras, device security, account
erasure, shipped). Both siblings said the same thing about billing: "never part of this roadmap
line to begin with" (Wave 1 §2) and "billing... [not] part of this roadmap line" (Wave 2 §2). This
wave is the first time it is.

---

## 1. What this wave found

Nothing here is a security bug — that distinction matters enough to say first. Re-reading Wave 1
against the actual code confirms the separation it built is real:

- **Org role never grants anything platform-wide.** `identity.memberships.role` is scoped by a
  composite `(org_id, user_id)` row under RLS; owning or being Owner of any number of orgs
  produces exactly that many independent, non-overlapping memberships. `packages/policy/src/
  roles.ts`'s `OWNER` constant is `PERMISSIONS` — every permission that exists — but every one of
  them is evaluated inside `withOrgScope(theOneOrgTheyOwn)`. There is no code path from "Owner of
  Org A" to "anything about Org B."
- **Platform operator never derives from org role.** `platform.operators` (migration 0035) has no
  `org_id` column and no relationship to `identity.memberships` at all — `isPlatformOperator`
  (`apps/api/src/platform-admin/operator.ts`) is a flat lookup by `user_id`, grantable only by a
  migration or a one-off script (`ai/phase-12-admin.md` §7 decision 7), never by a route.

So the two things the project owner's question named — "an org owner acting as the main admin"
and "no main admin panel with invoices" — are not the same finding. The first does not exist in
the code (confirmed above); the second is real, and it is real because **billing was explicitly
deferred twice**, which means there has never been anything for a platform-wide billing view to
show. The instinct that "the owner must be handling it somehow" is what fills a gap that has no
other owner yet — literally, there is no automated mechanism that ends access when a trial or a
subscription lapses, so the only thing standing between a stale trial org and continued access is
a human remembering to look. This wave replaces that human with a state machine.

## 2. In scope, and what stays out

**In scope:**

- A per-org billing/subscription state, separate from Wave 1's operator-controlled `status`
  column, with automatic transitions (trial start, trial expiry, payment failure, grace-period
  expiry, recovery) driven by a worker sweep and by Stripe webhooks — never by a person clicking
  a button on a schedule.
- A `PaymentProvider` interface (`packages/contracts`) with a Stripe implementation
  (`packages/payments`), following the exact seam `TelephonyProvider`/`StorageProvider` already
  established, so a second processor is an implementation swap, not a rewrite.
- The org owner's own billing view: current plan, trial countdown, "upgrade" → Stripe Checkout,
  "manage subscription" → Stripe's own customer portal. Gated on `org:billing`, a permission that
  has existed in `packages/policy`'s catalog since Phase 2 with no route to reach it until now.
- The platform console's missing piece: a Billing tab listing every org's plan, billing state,
  trial end date, and a link out to that org's Stripe customer — the "see all companies, manage
  them, see invoices" surface the project owner asked for directly.
- Enforcement: an org whose billing has genuinely lapsed (grace period exhausted, no payment)
  loses access through the *same* chokepoint Wave 1 built for operator suspension
  (`resolveOrgMembership`), not a second one.

**Deliberately out of scope:**

- **Seats / per-user pricing.** One plan, one price, one subscription per org for this wave. Seat
  metering is a real, separate pricing-model decision or the project owner has not made yet, and
  building metering against an unmade decision is the same mistake Wave 2 §2 named for SCIM
  ("building the paid-tier thing before its trigger exists").
- **Invoices mirrored into this database.** The platform console links to the org's record in
  Stripe rather than storing invoice rows here. Stripe is already the system of record for
  invoices, tax, and dunning emails; copying that data in creates a second copy that can drift
  and buys nothing — Wave 1 already made this exact call for org directory data ("cross-org data
  access stays structurally out of reach without a purpose-built, audited path").
- **Usage-based billing** (telephony spend passed through to the customer, storage overages). The
  spend-cap machinery in Phase 7 stops an org from costing *this deployment* money; it says
  nothing about charging the org for it, which is a distinct, unscoped feature.
- **Coupons, annual billing, proration edge cases beyond what Stripe Checkout/Billing Portal
  already handle for free.** Everything Stripe's own hosted UI does is free scope; anything this
  wave would have to hand-roll to do the same is not built.
- **Card data touching this application at all.** Checkout and the customer portal are Stripe-
  hosted redirects. This is not a preference — it is what keeps this deployment out of PCI scope
  entirely, the same reasoning that already keeps recording storage, magic-byte checks, and every
  other sensitive-data path in this codebase as narrow as possible.

## 3. Structural decisions

### 3.1 Two billing surfaces, and they are not the same feature wearing two skins

This is the crux of the project owner's question, made structural rather than left as a norm to
remember:

- **`org:billing`** — owner-only (per `packages/policy/src/roles.ts`, only `OWNER` carries it),
  answers "what does *my* org pay, and can I change it." Already in `ORG_LEVEL_PERMISSIONS`
  (`permissions.ts` §"never reachable through a resource tuple" — deliberately, since sharing a
  channel or a page can never imply the ability to change what the whole org is billed). Scoped
  by `withOrgScope`; an Owner of three orgs calls this three separate times, once per org, and
  never sees the other two.
- **`platformAdmin.billing`** — operator-only, exactly like every other `platformRoute` in
  `apps/api/src/platform-admin`. Answers "show me every org's billing state." Uses
  `withGlobalScope`/`taskflow_platform_admin`, the Wave 1 escape hatch, never `org:billing` — an
  Owner does not get this by being an Owner, and an operator does not need `org:billing` to use
  it, because the two permissions guard two different questions and neither implies the other.

Naming both "billing" invites exactly the conflation this wave exists to dissolve, so the spec
(and the routers) keep them under visibly different namespaces — `billing.*` (self, org-scoped)
and `platformAdmin.billing.*` (operator, global) — the same split Wave 1 already uses for
`self.check` versus everything else in `platform-admin/router.ts`.

### 3.2 Billing state is its own column, deliberately not folded into `status`

`identity.orgs.status` (`active | suspended | deleted`) is Wave 1's operator kill switch —
manual, for abuse and support tickets. This wave adds a second, independent column:

```sql
ALTER TABLE identity.orgs
  ADD COLUMN billing_status        text NOT NULL DEFAULT 'trialing',
  ADD COLUMN plan_id               text,
  ADD COLUMN trial_ends_at         timestamptz,
  ADD COLUMN billing_grace_ends_at timestamptz,
  ADD COLUMN stripe_customer_id    text,
  ADD COLUMN stripe_subscription_id text,
  ADD CONSTRAINT orgs_billing_status_valid
    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled')),
  ADD CONSTRAINT orgs_stripe_customer_key UNIQUE (stripe_customer_id),
  ADD CONSTRAINT orgs_stripe_subscription_key UNIQUE (stripe_subscription_id);
```

**Why not reuse `status`.** The tempting version collapses "billing lapsed" into
`status = 'suspended'` and gets automated enforcement for free with no new enforcement code. It
was rejected for a concrete failure mode: an operator suspends an org for a fraud investigation
(`status = 'suspended'`); the org's card is fine and Stripe keeps charging it successfully in the
background; the billing sweep, seeing a paid-up org, would "helpfully" flip `status` back to
`'active'` and undo the operator's action — automated billing recovery silently overriding a
manual security decision it has no way to know about. Two independent columns mean the billing
sweep only ever writes `billing_status`, the platform console only ever writes `status`, and
neither can clobber the other by construction, not by convention. This is the same "two facts,
two columns" call Phase 7 already made for `record`/`announcement_required` when folding them
together produced a real ambiguity.

**Enforcement stays at one chokepoint**, widened rather than duplicated. `resolveOrgMembership`
(`apps/api/src/tenancy/resolve.ts:114-141`) already reads `orgs.status` and is the single place
Wave 1 pointed out covers "every org-scoped tRPC route, every realtime room join, and every
collab page authorization... for free." This wave adds one more read to the same function, in the
same `withUserScope` transaction:

```ts
if (status === 'suspended') throw errors.orgSuspended();
if (status === 'deleted') return null;
if (billingStatus === 'canceled') throw errors.orgBillingLapsed();
```

`orgBillingLapsed` is a new, distinct `AppError` (`packages/contracts/src/errors.ts`, alongside
`orgSuspended`) rather than reusing `ORG_SUSPENDED` — an Owner staring at a locked-out org needs
to know *which* wall they hit ("pay us" vs. "call support"), the identical reasoning
`resolveOrgMembership`'s own comment already gives for treating `suspended` and `deleted`
differently rather than collapsing them.

**`trialing`, `active`, and `past_due` never block.** Only `canceled` does. A `past_due` org (a
card declined, a webhook says so) keeps working for the length of its grace period — blocking on
the first failed charge would lock out an org over a transient card-network hiccup, which is a
worse failure mode than a few extra grace-period days of access. The grace period's existence is
what turns `past_due` into `canceled`: a worker action, not a webhook event, closing §3.4.

### 3.3 `PaymentProvider` — the same seam as every other external dependency here

`packages/contracts/src/providers/payment-provider.ts`, modeled directly on
`telephony-provider.ts`'s shape (interface pins behavior; the gate/decision logic that calls it
lives in `apps/api`, never in the provider itself):

```ts
export interface PaymentProvider {
  readonly isLive: boolean;

  ensureCustomer(options: { readonly orgId: OrgId; readonly email: string }): Promise<{
    readonly customerId: string;
  }>;

  createCheckoutSession(options: {
    readonly customerId: string;
    readonly planId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }>;

  createPortalSession(options: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }>;

  /** Verifies and parses an inbound webhook body against the provider's own
   *  signature scheme — the one method here that is a security control rather
   *  than an action, matching TelephonyProvider.verifyWebhookSignature. */
  parseWebhookEvent(options: {
    readonly payload: string;
    readonly signature: string;
    readonly webhookSecret: string;
  }): BillingWebhookEvent;
}
```

`BillingWebhookEvent` is a small closed union — `subscription_activated | payment_failed |
payment_recovered | subscription_canceled` — the provider's own richer event vocabulary (Stripe
alone has dozens of event types) is translated down to this shape *inside* the provider
implementation, so nothing in `apps/api` ever pattern-matches on a Stripe-specific string. This is
the actual mechanism behind "swap the provider with minimal changes": every call site — the
checkout route, the portal route, the webhook handler — is written against these four members and
never imports `stripe` directly, matching the ESLint-enforced pattern that keeps `pg` out of
everywhere but `packages/db`.

`packages/payments/` (new package, sibling to `packages/telephony`):

- `stripe.ts` — `StripePaymentProvider`, thin wrapper over the `stripe` SDK.
- `fake.ts` — `FakePaymentProvider`, in-memory, `isLive: false`. Every route in this wave must
  work end-to-end against it with zero Stripe account — the same non-negotiable Wave 1 §"why this
  lives here" already sets for `FakeTelephonyProvider`, and the same reason a developer cloning
  this repo must not need a Stripe account to run `pnpm verify`.

`apps/api/src/billing/deps.ts`, mirroring `telephony/deps.ts`'s exact shape:

- `PAYMENTS_PROVIDER` env var, `'stripe' | 'fake'`, **explicit rather than credential-sniffed**
  (unlike telephony's `ACtest`-prefix marker) — per the project owner's own instruction: a named
  switch, not an inferred one, is what "use another provider later with minimal changes" means in
  practice. Defaults to `'fake'` so an unconfigured deployment boots clean.
  - `'stripe'` requires `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` — **refuses at boot** if
    either is missing, the same `TELEPHONY_INDEX_KEY`-style fail-closed check telephony's own
    deps.ts uses, for the identical reason: a half-configured provider that boots successfully
    fails at the first real checkout instead of at startup, which is a worse place to discover it.
  - `'fake'` needs nothing.
- `BILLING_PLAN_IDS` — a small JSON/CSV env value mapping this app's internal plan ids (`'pro'`,
  today the only one) to the payment provider's own price/plan identifiers (Stripe Price IDs).
  Indirection here, not a hardcoded Stripe Price ID in application code, is the other half of
  "swap providers later": the internal plan id is what routes and the UI ever reference.
- `BILLING_TRIAL_DAYS` (default 14) and `BILLING_PAST_DUE_GRACE_DAYS` (default 7) — both plain
  integers, tunable per deployment without a migration, the same reasoning
  `TELEPHONY_DEFAULT_SPEND_CAP_CENTS` already established for a business constant that is not a
  security boundary and should not require a code change to adjust.

### 3.4 Trial start, expiry, and the grace period — all automatic, none of them the Owner's job

- **`orgs.create` sets `billing_status = 'trialing'`, `trial_ends_at = now() + BILLING_TRIAL_DAYS
  days`** in the same transaction that already writes the org and its founding membership
  (`org.service.ts`) — one more field on a write path that already exists, not a second write.
- **A worker sweep** (`apps/worker`, alongside the automation engine and webhook delivery per
  CLAUDE.md's own placement rule — "takes only work added from Phase 10 onward," and this is
  exactly that shape of recurring job, not one of the seven legacy `apps/api` intervals) runs on a
  short interval and:
  - `trialing` past `trial_ends_at` with no `stripe_subscription_id` → `billing_status =
    'past_due'`, `billing_grace_ends_at = now() + BILLING_PAST_DUE_GRACE_DAYS days`. Not
    `canceled` directly — a trial that ends on a Friday should not lock someone out before they
    have had a business day to notice, which is what the grace period is for.
  - `past_due` past `billing_grace_ends_at` → `billing_status = 'canceled'`. This is the write
    that `resolveOrgMembership` (§3.2) starts refusing on.
  - Each transition is one conditional `UPDATE ... WHERE billing_status = <fromStatus>`, the same
    `claimForScanning`/`suspendOrg` conditional-write shape used everywhere else in this codebase
    a state machine needs to avoid two racing writers double-applying a transition.
- **Stripe webhooks** (`invoice.payment_failed`, `invoice.payment_succeeded`,
  `customer.subscription.deleted`) move the state the other direction, immediately rather than
  waiting for the sweep's next tick: a successful payment on a `past_due` org clears
  `billing_grace_ends_at` and sets `billing_status = 'active'` the moment Stripe confirms it, not
  up to one sweep interval later.
- **Nowhere in this flow does an Owner or an operator take a manual action for the common case.**
  The two humans in this system only get involved for the exceptions: an Owner who wants to
  upgrade early (Checkout) or manage/cancel (Portal), and an operator who wants to override a
  billing decision for a support case (§3.6).

### 3.5 The webhook handler follows telephony's own order-of-operations, not a new one

`apps/api/src/billing/webhook.ts` (⚠ human-review surface, joining CLAUDE.md's list alongside
telephony's `webhook.ts` — identical severity: an unverified webhook here can silently reactivate
or cancel access for an org). The sequence, matching Phase 7 Wave 1's own worked reasoning:

1. Read the Stripe customer id from the **unverified** body — a lookup key, not an assertion (the
   same argument `AccountSid` gets in the telephony webhook, and the same argument
   `x-taskflow-org` gets in every ordinary request).
2. Resolve `stripe_customer_id → orgId` via `identity.orgs`.
3. Verify the signature (`parseWebhookEvent`, using the **global** `STRIPE_WEBHOOK_SECRET` — one
   secret for the whole Stripe account, not per-org the way telephony's per-subaccount signing
   works, because Stripe's own webhook model is account-level).
4. Only after the signature passes: check `billing.webhook_events` for the Stripe event id
   (idempotency — Stripe retries undelivered webhooks, and a retry must not double-apply a state
   transition), then apply the transition and record the event id, in one transaction. Recording
   the id happens *inside* the same transaction as the effect, not before it — the identical
   "written on success" reasoning telephony's own nonce-recording gives, so a failed handler
   attempt does not poison a retry that would otherwise recover it.

New table, mirroring `comms.webhook_nonces`'s shape and grants:

```sql
CREATE TABLE billing.webhook_events (
  id           uuid        PRIMARY KEY,
  provider_event_id text   NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_event_id)
);
```

### 3.6 What an operator can and cannot do to another org's billing

The platform console's Billing tab is **read-plus-link**, not read-write, for this wave:
`platformAdmin.billing.list` returns every org's `plan_id`, `billing_status`, `trial_ends_at`, and
a constructed link into the Stripe Dashboard for that customer — the "see all companies... see
invoices" ask, answered by linking to the system that already has that data rather than mirroring
it (§2). The one write this wave does give an operator: `platformAdmin.billing.grantExtension`
(`platformRoute`), which pushes `billing_grace_ends_at` out by an operator-chosen number of days —
the support-ticket escape hatch ("we know, give them another week") — audited the same way every
other `platformRoute` write is (Wave 1's global operator chain), and explicitly **not** a way to
flip `billing_status` directly, because a support agent silently marking an unpaid org `'active'`
is exactly the kind of action that belongs in Stripe's own record, not a button in this console.

### 3.7 Org creation stays uncapped per user

Explicitly re-confirming Wave 1's own decision rather than revisiting it: nothing in this wave
limits how many orgs one person may create or own. The 3/day rate limit `orgs.create` already has
(Wave 1 §"the email-verification gate and 3/day rate limit") is an abuse control, not a business
rule, and stays exactly as it is. Each new org gets its own independent trial and its own
independent billing state — owning five orgs means paying for (or trialing) five orgs, with zero
shared standing between them, which is the direct product of §3.1's "two billing surfaces" split
holding at the data level too.

## 4. Event catalog

Six new events, `<resource>.<past_tense_verb>` per the registry's own enforced format
(`packages/events/src/registry.ts`):

- **`billing.trial_started`** — `{ orgId, trialEndsAt }`, emitted from `org.service.ts::createOrg`
  in the same transaction as `org.created`.
- **`billing.subscription_activated`** — `{ orgId, planId, stripeSubscriptionId }` — Checkout
  completes or a `past_due` org's payment recovers.
- **`billing.payment_failed`** — `{ orgId }` — `trialing`/`active` → `past_due`.
- **`billing.org_suspended_for_nonpayment`** — `{ orgId }` — `past_due` → `canceled`, the sweep's
  own write. Deliberately a distinct event from `platform.org_suspended` (Wave 1) even though the
  user-visible effect (locked out) rhymes — different cause, different column, different audience
  reading the audit log later trying to understand why access stopped.
- **`billing.subscription_canceled`** — `{ orgId }` — Owner-initiated cancel via the customer
  portal.
- **`billing.grace_extended`** — `{ orgId, operatorUserId, extendedToDate }` — §3.6's operator
  override, into `platform.operator_audit_log` (the Wave 1 dual-audit pattern: this also needs an
  org-visible entry, since unlike a cross-org user-suspend, there is a single obvious org audience
  for "an operator gave you more time").

## 5. Web UI surface

- **Org Settings → Billing** (new tab, `org:billing` gated — renders nothing for anyone else, per
  §8.2's existing rule that authorization is never re-derived client-side, just like every other
  gated tab in this app): current plan, trial countdown while `trialing`, a banner while
  `past_due` naming the grace deadline, "Upgrade" (→ Checkout) and "Manage subscription" (→
  Portal) buttons.
- **`platform-admin-page.tsx`** gains a **Billing** tab: every org's plan/status/trial-end, a
  Stripe Dashboard link per row, and the grace-extension action (§3.6).
- **A locked-out org** (`orgBillingLapsed`) gets its own honest state on every page, the same
  pattern `orgSuspended` already has — not a generic error, a specific "trial ended, add a
  payment method" screen with the upgrade link, reachable even though every other route just
  refused the caller.

## 6. Cross-cutting obligations

`apps/api/src/billing/webhook.ts` and `packages/payments` join CLAUDE.md's human-review list,
identical severity to telephony's webhook surface — both move an org between "has access" and
"does not" based on an unauthenticated caller's claim, verified only by a signature.

**Tests ship with the slice:**

- A test proving `resolveOrgMembership` refuses a `canceled`-billing org identically across a
  plain route, a realtime room join, and a collab page authorization (mirroring Wave 1's own
  suspension test shape across the same three surfaces).
- A test proving an operator-suspended (`status`) org is not silently reactivated by a billing
  webhook, and a billing-canceled org is not silently reactivated by an operator's unrelated
  `orgs.reactivate` call — the §3.2 non-clobbering guarantee, asserted rather than assumed.
- A test proving the webhook handler never applies a transition before the signature check passes
  (the telephony webhook test's own shape, ported).
- A test proving a replayed webhook event id is a no-op the second time.
- A test proving every billing route works end-to-end against `FakePaymentProvider` with
  `PAYMENTS_PROVIDER` unset — no Stripe account required to run `pnpm verify`.
- A test proving `billing.webhook_events` is unreadable/unwritable from `taskflow_app` directly
  (the `platform.operators`/`identity.secret_keys` grant-correctness pattern, repeated).

## 7. Decisions

1. **Two independent columns (`status`, `billing_status`), never one.** §3.2. The alternative
   (folding billing into `status`) was rejected for a concrete cross-write hazard, not on style
   grounds.
2. **Provider chosen via an explicit env var, not credential-sniffed.** §3.3, per the project
   owner's direct instruction — `PAYMENTS_PROVIDER=stripe|fake`, so a future second processor is
   a new `PaymentProvider` implementation plus one env value, never a call-site change.
3. **No card data ever reaches this application.** Checkout and the customer portal are Stripe-
   hosted redirects, unconditionally, for every provider this interface will ever be asked to
   support — a provider that could only be integrated by collecting card numbers directly is not
   a provider this interface accepts.
4. **`past_due` does not block; only `canceled` does, after a grace period.** §3.2, §3.4 — a
   declined card is treated as "probably transient" for `BILLING_PAST_DUE_GRACE_DAYS`, not as an
   immediate lockout.
5. **Org creation stays uncapped per user.** §3.7 — re-affirmed, not revisited. The abuse control
   (3/day) and the business model (pay per org) are different concerns and neither implies a cap
   on how many orgs one person may own.
6. **The platform console links to Stripe rather than mirroring invoices.** §2, §3.6 — Stripe
   stays the system of record; this console is a directory with a door into it, not a second copy.

## 8. Sequencing and cost

Depends on Wave 1 (complete) for `platformRoute`, the platform-admin module shape, and the
operator audit chain; depends on Phase 10's `apps/worker` (complete) as the home for the sweep,
per CLAUDE.md's own placement rule. Independent of Wave 2.

New surface: one `PaymentProvider` interface plus `packages/payments` (two implementations), six
new columns on `identity.orgs`, one new two-column table (`billing.webhook_events`), one widened
chokepoint (`resolveOrgMembership`, three added lines), one worker sweep, one webhook route, six
events, an org-settings Billing tab, and a platform-console Billing tab. Estimate: **1.5–2 weeks**
— smaller than either prior wave, because the hardest structural work (the operator/org-role
split, the suspension-enforcement chokepoint, the `platformRoute` shape) already exists and this
wave extends it rather than inventing a second version of it.
