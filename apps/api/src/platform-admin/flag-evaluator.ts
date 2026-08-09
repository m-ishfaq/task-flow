import { schema, withGlobalScope } from '@taskflow/db';
import { FLAG_NAMES, FeatureFlags, type FlagName } from '@taskflow/feature-flags';

/**
 * The live flag evaluator (Phase 12 Wave 1, ai/phase-12-admin.md §3.8).
 *
 * `platform.flag_overrides` is the store the evaluator never had: toggles in
 * the Flags tab write rows here, and nothing in the running system ever fed
 * them back into `FeatureFlags.evaluate()`. This module is that feed.
 *
 * ## Overrides merge into the ENV tier, not the org tier
 *
 * The spec's runbook proposed "merge overrides into the constructor's
 * env-shaped input" — that is what `buildFlags` does. `platform.flag_overrides`
 * is a GLOBAL store (no per-org row shape yet), and the evaluator's env tier
 * is the global tier: it applies to every flag regardless of `perOrg`, and it
 * outranks the registry default. The per-org tier (`FlagContext.orgOverrides`)
 * stays unused until genuine per-org targeting exists — the evaluator was
 * already shaped for it; nothing here invents it.
 *
 * The API's env schema does not parse `TASKFLOW_FLAG_*` yet, so the env tier
 * is exactly the override store today; if that parsing lands, it belongs in
 * the same tier (env first, then store overrides, matching the Flags tab's
 * "override beats environment beats default" display).
 *
 * ## Why the TTL cache
 *
 * The evaluator's own contract is that resolution is synchronous and
 * side-effect free — a flag check must never await a database read. So the
 * store is read here, off the request path, and cached; `getResolvedFlags()`
 * then serves the snapshot for the cache window without touching the
 * database. A toggle takes effect for the client within one TTL — a stale
 * flag for thirty seconds is the cost of keeping evaluation I/O-free, and it
 * is far cheaper than the per-request read the alternative would put in a
 * hot path.
 *
 * Lives in `apps/api/src/platform-admin` because the store read uses
 * `withGlobalScope` (the same no-RLS-table escape hatch `operator.ts`
 * documents), and that carve-out is path-scoped to identity, people, and
 * platform-admin.
 */

/** How long a loaded snapshot is served before the next read reloads. */
const CACHE_TTL_MS = 30_000;

let cached: { readonly at: number; readonly flags: FeatureFlags } | null = null;
let loading: Promise<FeatureFlags> | null = null;

/**
 * Builds an evaluator from a set of override rows — the store merged into
 * the env tier. Pure, so the Flags tab can resolve from the rows it just
 * read (fresh after a toggle) instead of the shared cache.
 */
export function buildFlags(
  overrides: readonly { readonly flagName: string; readonly value: boolean }[],
): FeatureFlags {
  const env: Partial<Record<FlagName, boolean>> = {};
  for (const row of overrides) {
    /* A row naming a flag that has since been deleted from the registry must
       not crash resolution — it is simply not resolvable. */
    if ((FLAG_NAMES as readonly string[]).includes(row.flagName)) {
      env[row.flagName as FlagName] = row.value;
    }
  }
  return new FeatureFlags(env);
}

async function loadFlags(): Promise<FeatureFlags> {
  const overrides = await withGlobalScope(async (tx) => tx.select().from(schema.flagOverrides));
  return buildFlags(overrides);
}

/**
 * The current evaluator — the store's rows as of the last load, cached with
 * a short TTL and single-flight so a burst of requests shares one read.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.flags;

  loading ??= loadFlags().then((flags) => {
    cached = { at: Date.now(), flags };
    return flags;
  });
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Every flag resolved at once — the client bootstrap payload (§3.8). */
export async function getResolvedFlags(): Promise<Record<FlagName, boolean>> {
  return (await getFeatureFlags()).snapshot();
}
