import { orgs } from './schema/tenancy.js';
import { withGlobalScope } from './client.js';

/**
 * Enumerating tenants, for jobs that must visit every one of them.
 *
 * ## Why this is in `packages/db` and not in the job that needs it
 *
 * `withGlobalScope` is banned outside this package by the guardrail-2 lint
 * rules, and that ban is the reason this file exists rather than an argument
 * against it. A background sweep — chat retention, and later the Phase 12
 * purge — genuinely has to work across organizations, and the tempting shape is
 * for the job to open a global scope "just to get the list". Once it holds one,
 * every subsequent query in that function is unscoped too, and nothing about
 * the code says so.
 *
 * So the escape hatch is confined to one exported function whose whole
 * signature is "give me the ids". A caller gets ids and nothing else, and has
 * to re-enter `withOrgScope` per org to do anything with them. The unscoped
 * read is one line, in the data layer, where the RLS tests can see it.
 *
 * ## `identity.orgs` is the tenant TABLE, not tenant data
 *
 * This is the distinction that makes the read defensible. Rows in `orgs` are
 * the list of tenants; rows in every other table BELONG to a tenant. Reading
 * the first across scopes exposes which organizations exist, which every
 * operator of this system already knows. Reading the second is the breach RLS
 * exists to prevent.
 *
 * Only ids are returned for that reason — no names, no slugs. A job that
 * iterates tenants needs to know which scopes to open and nothing more.
 */
export async function listOrgIds(): Promise<readonly string[]> {
  const rows = await withGlobalScope(async (tx) => tx.select({ id: orgs.id }).from(orgs));

  return rows.map((row) => row.id);
}
