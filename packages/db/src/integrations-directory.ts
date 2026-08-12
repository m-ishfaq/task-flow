import { and, eq } from 'drizzle-orm';
import { withIntegrationAuthScope } from './client.js';
import type { OrgId } from './client.js';
import { integrations } from './schema/platform.js';

/**
 * The inbound-connector scope → org lookup (ai/phase-10-automation.md §7.2,
 * §7.4; migration 0056).
 *
 * ## Why this lives in packages/db rather than in apps/api
 *
 * The same reason `comms-directory.ts` and `resolveApiToken` live here: an
 * inbound Slack/GitHub webhook must be resolved to an org BEFORE any scope is
 * open — the body names a Slack `team_id` or a GitHub `repository.full_name`,
 * and the row mapping that scope to an org is a TENANT row, so no value of
 * `app.org_id` is correct for the read. The narrow role that may reach across
 * orgs is only ever used through a named function in the data layer, where it
 * can be read in one sitting.
 *
 * ## What this can and cannot see
 *
 * The `taskflow_integration_auth` grant is column-level: `org_id, provider,
 * provider_scope` plus the GitHub verify columns — never `token_*`, never
 * `name`, never `status`. So this lookup answers WHO the request is for, and
 * nothing else: it cannot tell a connected row from a revoked one (that is
 * the route's job, under the org scope this returns), and it cannot read a
 * single outbound credential.
 *
 * ## The caller's obligation
 *
 * The org returned here is derived from an **unverified** payload — the body
 * of a webhook whose signature has not been checked yet (for GitHub, checking
 * it requires the per-org secret this lookup is the first step toward). So
 * the org id returned selects WHICH KEY to verify against; it is not a claim
 * that the request is legitimate, and nothing may be written under it until
 * the signature has passed. That ordering is the whole control: a caller
 * that writes first and verifies second has verified nothing (the telephony
 * webhook's `AccountSid` argument, restated for connectors).
 */
export async function resolveIntegrationOrg(
  provider: 'slack' | 'github',
  providerScope: string,
): Promise<OrgId | undefined> {
  if (providerScope.length === 0) return undefined;

  return withIntegrationAuthScope(async (tx) => {
    const rows = await tx
      .select({ orgId: integrations.orgId })
      .from(integrations)
      .where(
        and(eq(integrations.provider, provider), eq(integrations.providerScope, providerScope)),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : (row.orgId as OrgId);
  });
}
