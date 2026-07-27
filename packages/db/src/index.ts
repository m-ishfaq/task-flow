/**
 * @taskflow/db — the tenant-scoped data layer.
 *
 * Feature code imports ONLY from here. The ESLint guardrails ban importing `pg`,
 * `drizzle-orm/node-postgres`, or this package's internals from anywhere else,
 * so there is no supported way to obtain an unscoped connection (§2.1
 * guardrail 2).
 *
 * Typical use:
 *
 *   const cards = await withOrgScope(ctx.orgId, async (tx) =>
 *     tx.select().from(schema.cards).where(eq(schema.cards.boardId, boardId)),
 *   );
 *
 * Note there is no `org_id` in that WHERE clause. It is enforced by RLS, not by
 * the query — which is the entire point: forgetting it returns zero rows rather
 * than another tenant's data.
 */

export {
  initializeDatabase,
  closeDatabase,
  isDatabaseHealthy,
  withOrgScope,
  withGlobalScope,
  type OrgId,
  type DbConfig,
  type TenantDb,
  type GlobalDb,
} from './client.js';

export { TENANT_RLS_POLICY_SQL, tenantRlsPolicy } from './rls.js';

/*
 * Table definitions land here as each phase adds them:
 *   Phase 1  identity  — users, sessions, credentials
 *   Phase 2  identity  — orgs, memberships, teams;  authz — relationship tuples
 *   Phase 3  work      — projects, boards, lists, cards
 * Re-exported as `schema` so call sites read `schema.cards`.
 */
