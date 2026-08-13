import { and, countRows, eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { createEvent, type EventBus } from '@taskflow/events';
import { FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { errors } from '@taskflow/contracts';
import type { OrgId } from '@taskflow/contracts';
import type { PaymentProvider, PlanInterval } from '@taskflow/contracts';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { invalidateEntitlements } from '../billing/entitlement-resolver.js';
import {
  orgEntitlementOverrideSet,
  orgPlanChanged,
  planArchived,
  planCreated,
  planPriceChanged,
  planUpdated,
} from './events.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The plan catalog — the operator's pricing surface (Phase 12 Wave 4,
 * ai/phase-12-wave4-plans.md §3.2, §3.9).
 *
 * Wave 3 had no catalog: one hardcoded `'pro'` literal, one env var holding a
 * Stripe Price id, and a Stripe dashboard you had to open to change anything.
 * This module is what removes the dashboard from that loop.
 *
 * ## Everything runs as `taskflow_platform_admin`, and nothing takes an org
 *
 * A plan belongs to no tenant — it is the thing tenants are on — so there is
 * no `withOrgScope` anywhere in this file and no org id in any signature. Same
 * structural reason `flags.service.ts` uses `withPlatformAdminScope`
 * throughout, and the same reason both tables carry no `org_id` and no RLS.
 *
 * ## Stripe first, our row second, and never the other way round
 *
 * Creating or repricing a plan is a database write plus a provider call, and
 * they cannot be one transaction. The order is chosen by which failure is
 * survivable (§3.9):
 *
 *   - Provider succeeds, our write fails  -> an orphaned Product/Price at the
 *     processor. Inert: nothing references it, nothing charges anyone, and an
 *     operator can retry immediately.
 *   - Our write succeeds, provider fails  -> a catalog row with a null price
 *     id. That is an Upgrade button an owner can click that cannot produce a
 *     checkout — a broken product surface, discovered by a customer.
 *
 * So the provider is called first, every time, and the row is written with the
 * ids it returned. There is no compensating delete on failure, deliberately:
 * a failed cleanup would be a second call that can also fail, and the state it
 * would leave behind is the one we already accept.
 */

/** What a plan's ceilings and usage-billing numbers are, on read and on write. */
export interface PlanLimitsInput {
  /** NULL is unlimited; 0 is none-at-all. Both are real, different states. */
  readonly telephonyCapCents: number | null;
  readonly automationRunsPerHour: number | null;
  readonly turnIssuancePerDay: number | null;
  readonly telephonyIncludedCents: number;
  readonly telephonyMarkupPct: number;
}

export interface PlanPriceView {
  readonly id: string;
  readonly interval: PlanInterval;
  readonly amountCents: number;
  readonly currency: string;
  readonly stripePriceId: string | null;
  /**
   * Where to go and confirm this price exists at the processor, or null when
   * the processor has no console (the fake) or the id is absent.
   *
   * A stored id is a CLAIM that an object was created; it is not evidence that
   * the object is still there, or that it belongs to the Stripe account this
   * deployment is currently pointed at. Nothing in the database can tell those
   * apart — only looking can.
   */
  readonly stripePriceUrl: string | null;
  readonly isCurrent: boolean;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

export interface PlanView extends PlanLimitsInput {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly stripeProductId: string | null;
  /** See `PlanPriceView.stripePriceUrl` — the same claim-versus-evidence gap. */
  readonly stripeProductUrl: string | null;
  readonly features: readonly string[];
  /** Current prices only. The retired ones are `listPrices`, so the common read stays one query per plan. */
  readonly currentPrices: readonly PlanPriceView[];
  /** How many orgs are on this plan — the number that makes archiving a decision rather than a click. */
  readonly orgCount: number;
  readonly updatedAt: Date;
}

export interface PlanCatalogDeps {
  readonly events: EventBus;
  readonly payments: PaymentProvider;
}

/**
 * Rejects a feature name the registry does not have.
 *
 * The database cannot enforce this — it has no way to know what
 * `packages/feature-flags` declares — so it is enforced here, at the only
 * writer. The precedent and the reasoning are
 * `packages/seed/src/modules/platform.admin.ts`'s: a flag renamed below this
 * check's notice is a row the evaluator silently ignores, which surfaces as a
 * paying customer's module being off with nothing in any log to say why.
 *
 * `telephonyLiveCredentials` is refused even though it IS in the registry.
 * It is declared `perOrg: false` because it is release plumbing that starts
 * real carrier spend (ai/phase-7-voice.md §8.5), not a product surface — so it
 * is not a thing a plan may grant, and a plan that appeared to grant it would
 * be making a spend decision through a pricing table.
 */
function assertGrantableFeatures(features: readonly string[]): void {
  const invalid: string[] = [];
  const ungrantable: string[] = [];

  for (const feature of features) {
    if (!FLAG_NAMES.includes(feature as FlagName)) {
      invalid.push(feature);
    } else if (feature === 'telephonyLiveCredentials') {
      ungrantable.push(feature);
    }
  }

  if (invalid.length > 0) {
    throw errors.validation(
      {
        features: `Not registered flags: ${invalid.join(', ')}. Available: ${FLAG_NAMES.join(', ')}.`,
      },
      'One or more features are not recognized.',
    );
  }
  if (ungrantable.length > 0) {
    throw errors.validation(
      {
        features:
          `${ungrantable.join(', ')} is release plumbing (perOrg: false), not a product surface — ` +
          'it controls live carrier spend and cannot be granted by a plan.',
      },
      'That feature cannot be part of a plan.',
    );
  }
}

/** Duplicate feature names are a no-op in the database and a confusing read back. */
function normalizeFeatures(features: readonly string[]): string[] {
  return [...new Set(features)].sort();
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

/**
 * The whole catalog, including retired plans.
 *
 * Retired plans are included rather than filtered, because this is the
 * operator's view: a tier that is no longer sold still has tenants on it, and
 * hiding it here would make "why is this org on a plan I cannot see" the first
 * question the console cannot answer. The owner-facing picker filters on
 * `isActive` at its own call site.
 */
export async function listPlans(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
): Promise<readonly PlanView[]> {
  const plans = await readPlans(deps);
  await recordOperatorAction(operator.userId, 'plans.list', null);
  return plans;
}

/**
 * The read itself, with no audit write.
 *
 * Split from `listPlans` because every mutation below re-reads through it to
 * build its return value, and routing those through the audited version would
 * put a spurious `plans.list` in the operator chain after every single
 * `plans.update` — an accountability record where half the entries are an
 * artifact of how the service assembles its response.
 */
async function readPlans(deps: PlanCatalogDeps): Promise<readonly PlanView[]> {
  const rows = await withPlatformAdminScope(async (tx) => {
    const plans = await tx.select().from(schema.plans).orderBy(schema.plans.sortOrder);

    /* Current prices for every plan in one read rather than per plan — the
       catalog is small, but N+1 in a console list is how a page that was fine
       with three plans becomes slow with thirty and nobody notices which
       change did it. */
    const prices = await tx
      .select()
      .from(schema.planPrices)
      .where(eq(schema.planPrices.isCurrent, true));

    /* Same, for the org counts. `plan_id` is indexed (0063). */
    const counts = await tx
      .select({ planId: schema.orgs.planId, orgCount: countRows(schema.orgs.id) })
      .from(schema.orgs)
      .groupBy(schema.orgs.planId);

    return { plans, prices, counts };
  });

  const countByPlan = new Map(rows.counts.map((row) => [row.planId, Number(row.orgCount)]));

  return rows.plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
    isDefault: plan.isDefault,
    stripeProductId: plan.stripeProductId,
    stripeProductUrl:
      plan.stripeProductId === null
        ? null
        : deps.payments.dashboardUrl({ kind: 'product', id: plan.stripeProductId }),
    features: plan.features,
    telephonyCapCents: plan.telephonyCapCents,
    automationRunsPerHour: plan.automationRunsPerHour,
    turnIssuancePerDay: plan.turnIssuancePerDay,
    telephonyIncludedCents: plan.telephonyIncludedCents,
    telephonyMarkupPct: plan.telephonyMarkupPct,
    currentPrices: rows.prices
      .filter((price) => price.planId === plan.id)
      .map((price) => toPriceView(deps, price)),
    orgCount: countByPlan.get(plan.id) ?? 0,
    updatedAt: plan.updatedAt,
  }));
}

/**
 * Every price a plan has ever had, newest first — the grandfathering ledger.
 *
 * This is the read that answers "who is still on the old price", which is the
 * question §3.2's whole append-and-archive design exists to keep answerable.
 */
export async function listPrices(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  planId: string,
): Promise<readonly PlanPriceView[]> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select()
      .from(schema.planPrices)
      .where(eq(schema.planPrices.planId, planId))
      .orderBy(schema.planPrices.createdAt),
  );

  await recordOperatorAction(operator.userId, 'plans.listPrices', { planId });

  return rows.map((row) => toPriceView(deps, row)).reverse();
}

function toPriceView(
  deps: PlanCatalogDeps,
  row: typeof schema.planPrices.$inferSelect,
): PlanPriceView {
  return {
    id: row.id,
    interval: row.interval,
    amountCents: row.amountCents,
    currency: row.currency,
    stripePriceId: row.stripePriceId,
    stripePriceUrl:
      row.stripePriceId === null
        ? null
        : deps.payments.dashboardUrl({ kind: 'price', id: row.stripePriceId }),
    isCurrent: row.isCurrent,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

/* -------------------------------------------------------------------------- *
 * Writes
 * -------------------------------------------------------------------------- */

export interface CreatePlanInput extends PlanLimitsInput {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly features: readonly string[];
  /**
   * Omitted for a plan with no paid price — the free tier. A plan created
   * without a processor product cannot later grow one through `update`,
   * deliberately: that would be a second creation path with its own ordering
   * problem, and `create` is cheap.
   */
  readonly withProduct: boolean;
}

export async function createPlan(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  input: CreatePlanInput,
): Promise<PlanView> {
  assertGrantableFeatures(input.features);
  const features = normalizeFeatures(input.features);

  const existing = await withPlatformAdminScope(async (tx) =>
    tx
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.id, input.id))
      .limit(1),
  );
  if (existing.length > 0) {
    throw errors.validation(
      { id: `A plan with id "${input.id}" already exists.` },
      'That plan id is taken.',
    );
  }

  /* The provider call comes FIRST — see this file's header on which failure is
     survivable. An orphaned product costs nothing and charges nobody. */
  const product = input.withProduct
    ? await deps.payments.createProduct({
        name: input.name,
        ...(input.description === null ? {} : { description: input.description }),
      })
    : undefined;

  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    await tx.insert(schema.plans).values({
      id: input.id,
      name: input.name,
      description: input.description,
      sortOrder: input.sortOrder,
      isActive: true,
      /* Never through this route. The default plan is where every expiring
         trial lands, so moving it is its own deliberate action with its own
         audit entry — not a checkbox on a create form somebody is filling in
         for a new tier. */
      isDefault: false,
      stripeProductId: product?.productId ?? null,
      features,
      telephonyCapCents: input.telephonyCapCents,
      automationRunsPerHour: input.automationRunsPerHour,
      turnIssuancePerDay: input.turnIssuancePerDay,
      telephonyIncludedCents: input.telephonyIncludedCents,
      telephonyMarkupPct: input.telephonyMarkupPct,
      updatedAt: now,
      updatedBy: operator.userId,
    });
  });

  await recordOperatorAction(operator.userId, 'plans.create', {
    planId: input.id,
    name: input.name,
    features,
    stripeProductId: product?.productId ?? null,
  });

  await deps.events.publish([
    createEvent(
      planCreated,
      {
        planId: input.id,
        name: input.name,
        stripeProductId: product?.productId ?? null,
        operatorUserId: operator.userId,
      },
      systemEnvelope(operator, now),
    ),
  ]);

  return requirePlan(deps, input.id);
}

/**
 * A patch. Every field optional, and every one explicitly `| undefined` —
 * `exactOptionalPropertyTypes` is on, so a Zod-parsed object whose absent keys
 * come through as `undefined` is not assignable to a bare `?:` property.
 * Spelling it out here is what lets the route hand its parsed input straight
 * across without a field-by-field conditional spread.
 */
export interface UpdatePlanInput {
  readonly planId: string;
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly features?: readonly string[] | undefined;
  readonly isActive?: boolean | undefined;
  readonly telephonyCapCents?: number | null | undefined;
  readonly automationRunsPerHour?: number | null | undefined;
  readonly turnIssuancePerDay?: number | null | undefined;
  readonly telephonyIncludedCents?: number | undefined;
  readonly telephonyMarkupPct?: number | undefined;
}

/**
 * Changes a plan's metadata, feature set or ceilings. Never its price — that
 * is `setPrice`, because repricing has consequences for existing customers
 * that editing a description does not, and a route that could do both would
 * make those consequences depend on which fields happened to be filled in.
 */
export async function updatePlan(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  input: UpdatePlanInput,
): Promise<PlanView> {
  const plan = await requirePlanRow(input.planId);

  if (input.features !== undefined) assertGrantableFeatures(input.features);

  const now = new Date();
  const changed: string[] = [];
  const patch: Record<string, unknown> = { updatedAt: now, updatedBy: operator.userId };

  /**
   * Records one field IF the caller supplied it AND it differs from what is
   * stored. Both halves matter: `undefined` means "not in this patch" (never
   * "set to null" — that is an explicit `null`), and an unchanged value must
   * not reach `changed`, or every save emits a change event listing fields
   * nobody edited.
   */
  const assign = (key: string, value: unknown, current: unknown): void => {
    if (value === undefined) return;
    const next = key === 'features' ? normalizeFeatures(value as string[]) : value;
    /* Structural compare — `features` is an array, so `!==` would report every
       save as a change. */
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    patch[key] = next;
    changed.push(key);
  };

  assign('name', input.name, plan.name);
  assign('description', input.description, plan.description);
  assign('sortOrder', input.sortOrder, plan.sortOrder);
  assign('features', input.features, plan.features);
  assign('isActive', input.isActive, plan.isActive);
  assign('telephonyCapCents', input.telephonyCapCents, plan.telephonyCapCents);
  assign('automationRunsPerHour', input.automationRunsPerHour, plan.automationRunsPerHour);
  assign('turnIssuancePerDay', input.turnIssuancePerDay, plan.turnIssuancePerDay);
  assign('telephonyIncludedCents', input.telephonyIncludedCents, plan.telephonyIncludedCents);
  assign('telephonyMarkupPct', input.telephonyMarkupPct, plan.telephonyMarkupPct);

  /* A no-op update still records the read as an operator action (every
     platformAdmin call does) but must not emit a change event — a subscriber
     acting on "the plan changed" would be acting on nothing, and an audit
     trail full of empty changes is one nobody reads. */
  if (changed.length === 0) return requirePlan(deps, input.planId);

  await withPlatformAdminScope(async (tx) => {
    await tx.update(schema.plans).set(patch).where(eq(schema.plans.id, input.planId));
  });

  await recordOperatorAction(operator.userId, 'plans.update', {
    planId: input.planId,
    changed,
    /* Values, here, in the hash-chained record — not on the bus. See
       `planUpdated`'s own comment on why one of the two carries them. */
    patch: { ...patch, updatedBy: undefined, updatedAt: undefined },
  });

  await deps.events.publish([
    createEvent(
      planUpdated,
      { planId: input.planId, changed, operatorUserId: operator.userId },
      systemEnvelope(operator, now),
    ),
  ]);

  return requirePlan(deps, input.planId);
}

export interface SetPriceInput {
  readonly planId: string;
  readonly interval: PlanInterval;
  readonly amountCents: number;
  readonly currency: string;
}

/**
 * Sets the current price for a plan at one interval, grandfathering whatever
 * was there before.
 *
 * The order is create-then-retire, not retire-then-create: the partial unique
 * index allows exactly one current row per `(plan, interval)`, so the two
 * writes happen in one transaction — but the PROCESSOR calls happen either
 * side of it, and doing them the other way round would leave a window with a
 * retired price and no replacement, during which every checkout for that plan
 * fails.
 *
 * Nothing here touches an existing subscription. That is the entire point:
 * archiving a Stripe Price removes it from new checkouts and keeps billing
 * every subscription already on it, indefinitely (§3.2). An operator editing a
 * number in a console must not be able to change what a live customer's card
 * is charged.
 */
export async function setPrice(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  input: SetPriceInput,
): Promise<PlanView> {
  const plan = await requirePlanRow(input.planId);

  /**
   * A plan with no processor product gets one HERE, on first pricing.
   *
   * The alternative — refusing, as this did originally — created a dead end
   * with no way out of it. Migration 0063 seeds `free` and `pro` with a NULL
   * `stripe_product_id` because a migration cannot call Stripe, so on a
   * freshly migrated database BOTH seeded plans were permanently unsellable:
   * `setPrice` refused them, nothing else creates a product, and an operator's
   * only recourse was to abandon the seeded plan and create a new one under a
   * different id — while every existing org still pointed at the old one.
   *
   * Creating it on demand is also the honest reading of the action: attaching
   * a price to a plan IS the moment it becomes something you can sell, and it
   * is the first moment the processor needs to know the plan exists at all.
   *
   * Provider first, our row second, as everywhere else in this file — an
   * orphaned product is inert, a catalog row pointing at a product that was
   * never created is a checkout that 500s.
   */
  let productId = plan.stripeProductId;
  if (productId === null) {
    const product = await deps.payments.createProduct({
      name: plan.name,
      ...(plan.description === null ? {} : { description: plan.description }),
    });
    productId = product.productId;

    await withPlatformAdminScope(async (tx) => {
      await tx
        .update(schema.plans)
        .set({ stripeProductId: productId, updatedAt: new Date(), updatedBy: operator.userId })
        .where(eq(schema.plans.id, input.planId));
    });

    await recordOperatorAction(operator.userId, 'plans.attachProduct', {
      planId: input.planId,
      stripeProductId: productId,
    });
  }

  const previous = await withPlatformAdminScope(async (tx) =>
    tx
      .select()
      .from(schema.planPrices)
      .where(
        and(
          eq(schema.planPrices.planId, input.planId),
          eq(schema.planPrices.interval, input.interval),
          eq(schema.planPrices.isCurrent, true),
        ),
      )
      .limit(1),
  );
  const retiring = previous[0];

  /* How many orgs this decision leaves behind. Counted BEFORE the write, and
     an over-count rather than an exact one: an org on this plan may be on the
     other interval, or mid-trial with no subscription at all. Stated as
     "orgs on this plan" rather than pretending to a precision the schema
     cannot support — the exact figure needs a subscription-to-price mapping
     that only the processor holds. */
  const grandfathered = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({ n: countRows(schema.orgs.id) })
      .from(schema.orgs)
      .where(eq(schema.orgs.planId, input.planId));
    return Number(rows[0]?.n ?? 0);
  });

  const created = await deps.payments.createPrice({
    productId,
    amountCents: input.amountCents,
    currency: input.currency,
    interval: input.interval,
  });

  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    if (retiring !== undefined) {
      await tx
        .update(schema.planPrices)
        .set({ isCurrent: false, archivedAt: now })
        .where(eq(schema.planPrices.id, retiring.id));
    }

    await tx.insert(schema.planPrices).values({
      planId: input.planId,
      interval: input.interval,
      amountCents: input.amountCents,
      currency: input.currency,
      stripePriceId: created.priceId,
      isCurrent: true,
    });
  });

  /* The processor-side retirement comes LAST, after our own row is safely
     retired. If it fails, the old Price is still active at the processor but
     unreachable through this app — nothing links to it, so no new checkout can
     select it. The reverse order would retire it at the processor while our
     catalog still advertised it. */
  if (retiring?.stripePriceId != null) {
    await deps.payments.archivePrice(retiring.stripePriceId);
  }

  await recordOperatorAction(operator.userId, 'plans.setPrice', {
    planId: input.planId,
    interval: input.interval,
    previousAmountCents: retiring?.amountCents ?? null,
    amountCents: input.amountCents,
    currency: input.currency,
    grandfatheredOrgs: grandfathered,
  });

  await deps.events.publish([
    createEvent(
      planPriceChanged,
      {
        planId: input.planId,
        interval: input.interval,
        previousAmountCents: retiring?.amountCents ?? null,
        amountCents: input.amountCents,
        currency: input.currency,
        grandfatheredOrgs: grandfathered,
        operatorUserId: operator.userId,
      },
      systemEnvelope(operator, now),
    ),
  ]);

  return requirePlan(deps, input.planId);
}

/**
 * Retires a plan from sale. Orgs on it keep it and keep working.
 *
 * Not a delete — no role holds DELETE on `billing.plans`, and
 * `identity.orgs.plan_id` references it. Retiring a tier must never eject its
 * tenants; a plan with tenants on it is archived and stays referenced, which
 * is why `orgsRemaining` rides on the event and shows in the console.
 *
 * The default plan cannot be archived. It is where every expiring trial lands,
 * so archiving it would make the trial flow resolve to a plan that is no
 * longer sold, silently, at the moment a customer's access changes.
 */
export async function archivePlan(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  planId: string,
): Promise<PlanView> {
  const plan = await requirePlanRow(planId);

  if (plan.isDefault) {
    throw errors.validation(
      {
        planId:
          'The default plan cannot be archived — it is where every expiring trial and canceled ' +
          'subscription lands. Make another plan the default first.',
      },
      'That plan is the default.',
    );
  }

  const now = new Date();

  const orgsRemaining = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({ n: countRows(schema.orgs.id) })
      .from(schema.orgs)
      .where(eq(schema.orgs.planId, planId));
    return Number(rows[0]?.n ?? 0);
  });

  /* Every price under the plan is retired first, in our catalog and then at
     the processor — the processor REFUSES to archive a product with an active
     price under it (FakePaymentProvider reproduces that refusal deliberately),
     so this ordering is not a preference. */
  const livePrices = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.planPrices)
      .where(and(eq(schema.planPrices.planId, planId), eq(schema.planPrices.isCurrent, true)));

    await tx
      .update(schema.planPrices)
      .set({ isCurrent: false, archivedAt: now })
      .where(and(eq(schema.planPrices.planId, planId), eq(schema.planPrices.isCurrent, true)));

    await tx
      .update(schema.plans)
      .set({ isActive: false, updatedAt: now, updatedBy: operator.userId })
      .where(eq(schema.plans.id, planId));

    return rows;
  });

  for (const price of livePrices) {
    if (price.stripePriceId !== null) await deps.payments.archivePrice(price.stripePriceId);
  }
  if (plan.stripeProductId !== null) await deps.payments.archiveProduct(plan.stripeProductId);

  await recordOperatorAction(operator.userId, 'plans.archive', { planId, orgsRemaining });

  await deps.events.publish([
    createEvent(
      planArchived,
      { planId, orgsRemaining, operatorUserId: operator.userId },
      systemEnvelope(operator, now),
    ),
  ]);

  return requirePlan(deps, planId);
}

/**
 * Moves the default-plan marker.
 *
 * Two writes, one transaction, and the clear MUST come first: the database
 * allows at most one row with `is_default` (a partial unique index), so
 * setting the new one before clearing the old is refused outright. The same
 * "never an observable invalid moment" shape as `transferOwnership`'s
 * zero-owner window in Wave 1 — except here the database enforces it rather
 * than the service merely intending it.
 */
export async function setDefaultPlan(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  planId: string,
): Promise<PlanView> {
  const plan = await requirePlanRow(planId);

  if (!plan.isActive) {
    throw errors.validation(
      {
        planId:
          'An archived plan cannot be the default — expiring trials would land on a plan that is no longer sold.',
      },
      'That plan is archived.',
    );
  }

  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    await tx.update(schema.plans).set({ isDefault: false }).where(eq(schema.plans.isDefault, true));

    await tx
      .update(schema.plans)
      .set({ isDefault: true, updatedAt: now, updatedBy: operator.userId })
      .where(eq(schema.plans.id, planId));
  });

  await recordOperatorAction(operator.userId, 'plans.setDefault', { planId });

  await deps.events.publish([
    createEvent(
      planUpdated,
      { planId, changed: ['isDefault'], operatorUserId: operator.userId },
      systemEnvelope(operator, now),
    ),
  ]);

  return requirePlan(deps, planId);
}

/**
 * Moves ONE org onto a plan, by operator decision.
 *
 * ## This writes `plan_id` and nothing else
 *
 * Not `billing_status`, not `stripe_subscription_id`, not `trial_ends_at`. The
 * operator is answering "what is this org entitled to", which is a different
 * question from "what is this org paying", and 0059's whole two-columns
 * argument is that an automated billing writer and a human decision must never
 * be able to clobber each other. Extending this to touch the subscription
 * would rebuild exactly the collision that migration was written to prevent.
 *
 * The consequence, stated plainly because it is a real one: moving a paying
 * org to a cheaper plan here does NOT change what Stripe charges them. The
 * subscription is unchanged and the next invoice is the same. That is the
 * honest behaviour for an operator override — "give this customer Business
 * features while we sort out their contract" is the case it exists for — and
 * anything that silently repriced a live subscription from a console dropdown
 * would be worse.
 *
 * ## Retired plans are refused
 *
 * An org already on a retired plan keeps it (that is what archiving means).
 * Moving a NEW org onto one is different: it puts a tenant on a tier that is
 * no longer sold and no longer priced, which is how a plan nobody can renew
 * acquires new customers.
 */
export async function setOrgPlan(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  input: { readonly orgId: OrgId; readonly planId: string; readonly reason: string },
): Promise<{
  readonly orgId: OrgId;
  readonly planId: string;
  readonly previousPlanId: string | null;
}> {
  const plan = await requirePlanRow(input.planId);

  if (!plan.isActive) {
    throw errors.validation(
      {
        planId:
          `Plan "${input.planId}" is retired. Orgs already on it keep it, but moving one onto it ` +
          'now would put a tenant on a tier that is no longer sold or priced.',
      },
      'That plan is retired.',
    );
  }

  const now = new Date();

  /* Read-then-write in ONE transaction as the platform-admin role — the
     previous plan is part of the audit record, and reading it on a separate
     connection would let a concurrent change make the record describe a
     transition that never happened. */
  const previousPlanId = await withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({ planId: schema.orgs.planId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, input.orgId))
      .limit(1);

    const org = rows[0];
    if (!org) throw errors.notFound();

    await tx
      .update(schema.orgs)
      .set({ planId: input.planId })
      .where(eq(schema.orgs.id, input.orgId));

    return org.planId;
  });

  invalidateEntitlements(input.orgId);

  await recordOperatorAction(operator.userId, 'plans.setOrgPlan', {
    orgId: input.orgId,
    from: previousPlanId,
    to: input.planId,
    reason: input.reason,
  });

  await deps.events.publish([
    createEvent(
      orgPlanChanged,
      {
        orgId: input.orgId,
        from: previousPlanId,
        to: input.planId,
        actor: 'operator',
        operatorUserId: operator.userId,
      },
      /* The ORG's own id here, not SYSTEM_ORG: unlike a catalog change, this
         is a fact about one tenant, and their own audit history should carry
         "a platform operator moved this org to Business" without needing
         operator access to see it. Same reasoning `orgSuspended` gives. */
      {
        orgId: input.orgId,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { orgId: input.orgId, planId: input.planId, previousPlanId };
}

/**
 * Sets or clears ONE org's entitlement override — tier 1 of four (§3.1).
 *
 * The escape hatch that makes "give this one customer Docs while we sort out
 * their contract" possible without inventing a bespoke plan for them. It
 * outranks the plan, which is what makes it useful and what makes it need
 * every guard on it:
 *
 *   - `reason` is required, and the database refuses a blank one.
 *   - `expiresAt` is offered so a temporary grant does not become permanent by
 *     being forgotten; the resolver treats an expired row as absent.
 *   - Passing no deltas and no limits DELETES the row rather than writing an
 *     empty override, so "no override" is one state rather than two that
 *     resolve identically and read differently in the console.
 */
export async function setOrgEntitlements(
  deps: PlanCatalogDeps,
  operator: PlatformOperator,
  input: {
    readonly orgId: OrgId;
    readonly featuresAdd: readonly string[];
    readonly featuresRemove: readonly string[];
    readonly telephonyCapCents: number | null;
    readonly automationRunsPerHour: number | null;
    readonly turnIssuancePerDay: number | null;
    readonly reason: string;
    readonly expiresAt: Date | null;
  },
): Promise<{ readonly orgId: OrgId; readonly cleared: boolean }> {
  assertGrantableFeatures([...input.featuresAdd, ...input.featuresRemove]);

  const featuresAdd = normalizeFeatures(input.featuresAdd);
  const featuresRemove = normalizeFeatures(input.featuresRemove);

  /* The database forbids a name in both arrays
     (`org_entitlements_no_contradiction`). Caught here first so the operator
     gets a field error naming the feature rather than a constraint violation. */
  const both = featuresAdd.filter((name) => featuresRemove.includes(name));
  if (both.length > 0) {
    throw errors.validation(
      { featuresAdd: `Cannot both add and remove: ${both.join(', ')}.` },
      'A feature cannot be both added and removed.',
    );
  }

  const cleared =
    featuresAdd.length === 0 &&
    featuresRemove.length === 0 &&
    input.telephonyCapCents === null &&
    input.automationRunsPerHour === null &&
    input.turnIssuancePerDay === null;

  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    if (cleared) {
      await tx.delete(schema.orgEntitlements).where(eq(schema.orgEntitlements.orgId, input.orgId));
      return;
    }

    await tx
      .insert(schema.orgEntitlements)
      .values({
        orgId: input.orgId,
        featuresAdd,
        featuresRemove,
        telephonyCapCents: input.telephonyCapCents,
        automationRunsPerHour: input.automationRunsPerHour,
        turnIssuancePerDay: input.turnIssuancePerDay,
        reason: input.reason,
        expiresAt: input.expiresAt,
        setBy: operator.userId,
        setAt: now,
      })
      .onConflictDoUpdate({
        target: schema.orgEntitlements.orgId,
        set: {
          featuresAdd,
          featuresRemove,
          telephonyCapCents: input.telephonyCapCents,
          automationRunsPerHour: input.automationRunsPerHour,
          turnIssuancePerDay: input.turnIssuancePerDay,
          reason: input.reason,
          expiresAt: input.expiresAt,
          setBy: operator.userId,
          setAt: now,
        },
      });
  });

  /* The resolver caches per org for 30s. Dropping it here is not what makes
     the change correct — the TTL already does — it removes the window where
     an operator changes something and the console still shows the old answer. */
  invalidateEntitlements(input.orgId);

  await recordOperatorAction(
    operator.userId,
    cleared ? 'plans.clearOrgEntitlements' : 'plans.setOrgEntitlements',
    {
      orgId: input.orgId,
      featuresAdd,
      featuresRemove,
      reason: input.reason,
      expiresAt: input.expiresAt?.toISOString() ?? null,
    },
  );

  await deps.events.publish([
    createEvent(
      orgEntitlementOverrideSet,
      {
        orgId: input.orgId,
        featuresAdd,
        featuresRemove,
        cleared,
        reason: input.reason,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        operatorUserId: operator.userId,
      },
      {
        orgId: input.orgId,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { orgId: input.orgId, cleared };
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

function systemEnvelope(operator: PlatformOperator, occurredAt: Date) {
  /* SYSTEM_ORG, like every other platform-admin event: a plan belongs to no
     tenant, and `platform.outbox`'s RLS keys on `app.org_id` — see
     events.ts's header on why these travel the in-process bus. */
  return {
    orgId: SYSTEM_ORG,
    actorId: operator.userId,
    requestId: operator.requestId,
    occurredAt,
  };
}

async function requirePlanRow(planId: string): Promise<typeof schema.plans.$inferSelect> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx.select().from(schema.plans).where(eq(schema.plans.id, planId)).limit(1),
  );
  const plan = rows[0];
  if (!plan) throw errors.notFound();
  return plan;
}

/**
 * Re-reads a plan through the list's own shape so every mutation returns the
 * same view the list returns — including `orgCount` and `currentPrices`, which
 * a mutation would otherwise have to assemble a second time and could assemble
 * differently.
 */
async function requirePlan(deps: PlanCatalogDeps, planId: string): Promise<PlanView> {
  const plans = await readPlans(deps);
  const plan = plans.find((row) => row.id === planId);
  if (!plan) throw errors.notFound();
  return plan;
}
