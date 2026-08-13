import { eq, schema, withOrgScope } from '@taskflow/db';
import { FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { errors, type OrgId } from '@taskflow/contracts';
import { getFeatureFlags } from '../platform-admin/flag-evaluator.js';

/**
 * Entitlements — what an org's PLAN grants it (Phase 12 Wave 4,
 * ai/phase-12-wave4-plans.md §3.1, §3.4).
 *
 * ## This fills a tier that has existed since Phase 0 and never had a producer
 *
 * `FeatureFlags.evaluate()` has always resolved per-org override → environment
 * → registry default, and six flags have always been declared `perOrg: true`.
 * Nothing ever populated `FlagContext.orgOverrides` — `packages/db`'s own
 * schema file said outright that the tier "stays unused". This module is its
 * first consumer. It is not a new mechanism; it is the mechanism that was
 * designed for exactly this.
 *
 * ## The four tiers, and which one wins
 *
 *   1. Operator override   billing.org_entitlements  — outranks everything
 *   2. Plan                billing.plans.features
 *   3. Environment         the global flag-override store
 *   4. Registry default    packages/feature-flags
 *
 * Tiers 1 and 2 are computed here and handed to the evaluator as its ORG tier,
 * so they beat 3 and 4 by the evaluator's own precedence rather than by
 * anything this file does. That ordering has a consequence worth stating: a
 * plan grant BEATS a global operator flag override. That is deliberate — a
 * customer's paid entitlement must not be switched off by a deployment-wide
 * toggle aimed at a release, and the operator who genuinely needs to override
 * one org has tier 1 for it.
 *
 * ## An org with NO plan resolves to the registry, not to nothing
 *
 * `plan_id` is NULL while an org is trialing (0063 keeps it nullable for
 * exactly this). A trial is meant to feel like the product, so this returns an
 * empty org tier for that case and lets the environment and registry decide —
 * NOT an empty feature set, which would make a trial the most restricted state
 * in the system rather than the least.
 *
 * ## ⚠ This is PRODUCT SURFACE, never authorization
 *
 * Guardrail 7: a flag gates product surface and never a security control. A
 * plan check runs ALONGSIDE `can()`, never instead of it, and can only ever
 * REMOVE access:
 *
 *   - no `page:read`      -> FORBIDDEN, whatever the plan says
 *   - `page:read`, no plan -> PLAN_REQUIRED
 *
 * Neither answer is reachable by manipulating the other, and `packages/policy`
 * is not touched by this file. If a change here appears to need one, the
 * design is wrong.
 */

/** How long a resolved org tier is served before the next read reloads it. */
const CACHE_TTL_MS = 30_000;

interface Entitlements {
  /** The org tier handed to `FeatureFlags.evaluate()`. Empty means "inherit". */
  readonly features: Readonly<Partial<Record<FlagName, boolean>>>;
  /** Resolved ceilings — null is unlimited, 0 is none-at-all, undefined is "no opinion". */
  readonly limits: {
    readonly telephonyCapCents: number | null | undefined;
    readonly automationRunsPerHour: number | null | undefined;
    readonly turnIssuancePerDay: number | null | undefined;
    readonly telephonyIncludedCents: number | undefined;
    readonly telephonyMarkupPct: number | undefined;
  };
  /** Where each granted feature came from — the console renders this verbatim. */
  readonly sources: Readonly<Partial<Record<FlagName, 'plan' | 'override'>>>;
}

const EMPTY: Entitlements = {
  features: {},
  limits: {
    telephonyCapCents: undefined,
    automationRunsPerHour: undefined,
    turnIssuancePerDay: undefined,
    telephonyIncludedCents: undefined,
    telephonyMarkupPct: undefined,
  },
  sources: {},
};

const cache = new Map<OrgId, { readonly at: number; readonly value: Entitlements }>();
const loading = new Map<OrgId, Promise<Entitlements>>();

/** Only names the registry still defines. A deleted flag's leftover row is inert. */
function known(name: string): name is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(name);
}

/**
 * Reads and merges the two org-relative tiers.
 *
 * Read through `withOrgScope` as the ORDINARY application role: `taskflow_app`
 * holds SELECT on both catalog tables and on `billing.org_entitlements`, whose
 * RLS confines it to this org's own row. There is deliberately no privileged
 * path here — an entitlement read is not an operator action.
 */
async function loadEntitlements(orgId: OrgId): Promise<Entitlements> {
  return withOrgScope(orgId, async (tx) => {
    const orgRows = await tx
      .select({ planId: schema.orgs.planId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const planId = orgRows[0]?.planId ?? null;

    const planRows =
      planId === null
        ? []
        : await tx.select().from(schema.plans).where(eq(schema.plans.id, planId)).limit(1);
    const plan = planRows[0];

    const overrideRows = await tx
      .select()
      .from(schema.orgEntitlements)
      .where(eq(schema.orgEntitlements.orgId, orgId))
      .limit(1);
    const rawOverride = overrideRows[0];

    /* An EXPIRED override is not an override. Checked on read rather than
       swept on a timer: a sweep that has not run yet would leave a lapsed
       grant live, and the whole point of `expires_at` is that a temporary
       grant does not become permanent by being forgotten. */
    const override =
      rawOverride !== undefined &&
      (rawOverride.expiresAt === null || rawOverride.expiresAt.getTime() > Date.now())
        ? rawOverride
        : undefined;

    if (plan === undefined && override === undefined) return EMPTY;

    const features: Partial<Record<FlagName, boolean>> = {};
    const sources: Partial<Record<FlagName, 'plan' | 'override'>> = {};

    /* Tier 2 first, so tier 1 can overwrite it below. A plan grants ONLY what
       it lists — a feature absent from the list is left undecided here rather
       than set to false, so the environment and registry still get their say
       for an org whose plan predates a module. */
    for (const name of plan?.features ?? []) {
      if (!known(name)) continue;
      features[name] = true;
      sources[name] = 'plan';
    }

    /* Tier 1. `features_remove` is applied AFTER `features_add` only in the
       sense that the database forbids a name appearing in both
       (`org_entitlements_no_contradiction`), so order between them cannot
       matter — but both must come after the plan. */
    for (const name of override?.featuresAdd ?? []) {
      if (!known(name)) continue;
      features[name] = true;
      sources[name] = 'override';
    }
    for (const name of override?.featuresRemove ?? []) {
      if (!known(name)) continue;
      features[name] = false;
      sources[name] = 'override';
    }

    /* `??` and not `||`: 0 is a real ceiling meaning "none at all", and `||`
       would silently promote it to the plan's value — turning "this org may
       not spend" into "this org may spend whatever the plan allows". */
    const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | null | undefined =>
      a ?? b;

    return {
      features,
      sources,
      limits: {
        telephonyCapCents: pick(override?.telephonyCapCents, plan?.telephonyCapCents),
        automationRunsPerHour: pick(override?.automationRunsPerHour, plan?.automationRunsPerHour),
        turnIssuancePerDay: pick(override?.turnIssuancePerDay, plan?.turnIssuancePerDay),
        telephonyIncludedCents:
          pick(override?.telephonyIncludedCents, plan?.telephonyIncludedCents) ?? undefined,
        telephonyMarkupPct:
          pick(override?.telephonyMarkupPct, plan?.telephonyMarkupPct) ?? undefined,
      },
    };
  });
}

/**
 * The org's entitlements, cached with a short TTL and single-flight per org.
 *
 * Same contract and same reasoning as `flag-evaluator.ts`'s global cache: flag
 * evaluation is synchronous and side-effect free by design, so the read
 * happens here, off the evaluation path. A plan change takes effect within one
 * TTL — thirty seconds of staleness is the cost of keeping `isEnabled()` from
 * ever touching the database, and it is far cheaper than a per-check read in a
 * render path.
 */
export async function getEntitlements(orgId: OrgId): Promise<Entitlements> {
  const hit = cache.get(orgId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const inFlight = loading.get(orgId);
  if (inFlight !== undefined) return inFlight;

  const promise = loadEntitlements(orgId)
    .then((value) => {
      cache.set(orgId, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      loading.delete(orgId);
    });

  loading.set(orgId, promise);
  return promise;
}

/**
 * Drops one org's cached entitlements.
 *
 * Called by the writers — `setOrgPlan`, the entitlement-override routes — so
 * an operator who changes a plan and immediately reloads the console sees the
 * change rather than waiting out a TTL. Belt and braces: the TTL alone is
 * correct, this only removes the confusing window.
 */
export function invalidateEntitlements(orgId: OrgId): void {
  cache.delete(orgId);
}

/** Test seam: drops every cached org. Never called by application code. */
export function resetEntitlementCache(): void {
  cache.clear();
  loading.clear();
}

/**
 * Whether one flagged module is available to this org.
 *
 * The full four-tier answer: the org tier from the plan/override, handed to
 * the same `FeatureFlags` instance the global store already feeds, so
 * environment and registry precedence are the evaluator's rather than
 * reimplemented here.
 */
export async function isFeatureEnabled(orgId: OrgId, flag: FlagName): Promise<boolean> {
  const [flags, entitlements] = await Promise.all([getFeatureFlags(), getEntitlements(orgId)]);
  return flags.isEnabled(flag, { orgOverrides: entitlements.features });
}

/** Every flag resolved for this org — the client bootstrap's org-aware snapshot. */
export async function getOrgFlagSnapshot(orgId: OrgId): Promise<Record<FlagName, boolean>> {
  const [flags, entitlements] = await Promise.all([getFeatureFlags(), getEntitlements(orgId)]);
  return flags.snapshot({ orgOverrides: entitlements.features });
}

/**
 * Refuses with `PLAN_REQUIRED` when this org's plan does not include a module.
 *
 * ## Call this AFTER `can()`, never instead of it
 *
 * That ordering is the entire guardrail-7 argument in one line. `route({
 * permission })` has already run by the time a handler body executes, so a
 * caller reaching this was already authorized by their ROLE — which means:
 *
 *   - This can only ever REMOVE access, never grant it. There is no input to
 *     this function that turns a FORBIDDEN into a success.
 *   - `PLAN_REQUIRED` therefore leaks nothing. Telling the caller which module
 *     they are missing is safe precisely because they were entitled to know it
 *     exists; someone whose role forbids it never gets this far.
 *
 * Inverting the order would make a plan check into an authorization check, and
 * a plan is data an operator edits from a console. Do not.
 *
 * @param display Human-readable module name for the message ("Docs", "Voice").
 *   Separate from the flag name so the error reads like the product rather
 *   than like the registry.
 */
export async function requireFeature(
  orgId: OrgId,
  flag: FlagName,
  display: string,
): Promise<void> {
  if (await isFeatureEnabled(orgId, flag)) return;
  throw errors.planRequired(display);
}
