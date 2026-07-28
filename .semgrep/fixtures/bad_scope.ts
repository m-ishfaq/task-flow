/**
 * Deliberate violation, for scripts/verify-semgrep-rules.mjs.
 *
 * `global-scope-outside-identity` was written before the identity module existed
 * and excluded two paths that never did: `apps/api/src/auth/**` and
 * `apps/api/src/modules/identity/**`. The code landed at `apps/api/src/identity`,
 * so the rule reported every legitimate call in the repository and nothing else
 * — a rule that is simultaneously useless and noisy, which is how it gets muted.
 *
 * Nothing caught that, because the rule verifier only covered the three SQL
 * rules. This fixture is why it now covers the scope rule too.
 *
 * The path matters: `.semgrep/fixtures/**` is in the rule's `include` list and
 * is excluded from the real scan.
 */

declare const withGlobalScope: <T>(fn: () => Promise<T>) => Promise<T>;

export async function readsEveryTenant(): Promise<unknown> {
  // No tenant context, so every RLS policy filters to zero rows. Outside the
  // identity module this is always a mistake — and one that reads as "no data"
  // rather than "wrong scope".
  return withGlobalScope(async () => Promise.resolve([]));
}
