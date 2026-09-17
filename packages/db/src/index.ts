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
  withUserScope,
  withGlobalScope,
  initializeAuditDatabase,
  withAuditScope,
  hasAuditDatabase,
  initializeRealtimeDatabase,
  withRealtimeScope,
  hasRealtimeDatabase,
  createRealtimeAdapterPool,
  initializeCollabDatabase,
  withCollabScope,
  hasCollabDatabase,
  initializeBacklinksDatabase,
  withBacklinksScope,
  hasBacklinksDatabase,
  initializeSweepDatabase,
  withSweepScope,
  hasSweepDatabase,
  initializeRecordingIngestDatabase,
  withRecordingIngestScope,
  hasRecordingIngestDatabase,
  initializePlatformAdminDatabase,
  withPlatformAdminScope,
  hasPlatformAdminDatabase,
  initializeSearchDatabase,
  withSearchScope,
  hasSearchDatabase,
  initializeAutomationDatabase,
  withAutomationScope,
  hasAutomationDatabase,
  initializeWebhookDatabase,
  withWebhookScope,
  hasWebhookDatabase,
  initializeApiTokenAuthDatabase,
  withApiTokenAuthScope,
  hasApiTokenAuthDatabase,
  initializeBillingSweepDatabase,
  withBillingSweepScope,
  hasBillingSweepDatabase,
  initializeIntegrationAuthDatabase,
  withIntegrationAuthScope,
  hasIntegrationAuthDatabase,
  initializeOpsEventsDatabase,
  withOpsEventScope,
  hasOpsEventsDatabase,
  type OrgId,
  type UserId,
  type DbConfig,
  type TenantDb,
  type GlobalDb,
} from './client.js';

export {
  appendToOutbox,
  outboxWriter,
  claimPending,
  markDispatched,
  recordFailure,
  type OutboxRow,
} from './outbox.js';

export { listenForOutboxAppends, type OutboxListener, type ListenOptions } from './notify.js';

/**
 * The one telephony read that has no org yet (Phase 7 Wave 1, §3.11).
 *
 * Here rather than in `apps/api/src/telephony` because it needs
 * `withGlobalScope`, which is lint-restricted to this package and the identity
 * module. See the file's own header for what it can and cannot see, and for the
 * ordering obligation it puts on its caller.
 */
export { resolveOrgBySubaccountSid } from './comms-directory.js';
export { resolveOrgByStripeCustomerId } from './billing-directory.js';
export { resolveOrgByInvitationToken } from './tenancy-directory.js';
export { resolveApiToken } from './api-tokens.js';
export { recordOperationalEvent, type OperationalEventInput } from './ops-events.js';

/**
 * The one connector read that has no org yet (Phase 10 Wave 4, §7.2/§7.4).
 *
 * Here rather than in `apps/api/src/automation` because it needs
 * `withIntegrationAuthScope`, which is lint-restricted to this package. See
 * the file's own header for what it can and cannot see, and for the ordering
 * obligation it puts on its caller: the org it returns selects WHICH KEY to
 * verify an inbound webhook against, and nothing may be written until the
 * signature has passed.
 */
export { resolveIntegrationOrg } from './integrations-directory.js';

export {
  claimUnprocessedPageVersions,
  markBacklinksProcessed,
  type UnprocessedPageVersion,
} from './docs-backlinks.js';

export { walRowsSinceLatestSnapshot } from './docs-materialize.js';

export { readNotificationPrefsTimezone } from './notification-prefs-timezone.js';

export { consumeAutomationBudget } from './automation-budget.js';

export {
  consumeApiTokenQuota,
  API_TOKEN_DAILY_QUOTA,
  API_TOKEN_EXPENSIVE_DAILY_QUOTA,
  type ApiTokenQuotaClass,
} from './api-token-quota.js';

export {
  readAuditEntries,
  readAuditChain,
  insertAuditEntry,
  appendAuditEntry,
  type AuditEntryRow,
  type AuditChainRow,
  type NewAuditEntry,
  type ReadAuditInput,
} from './audit-log.js';

export {
  TENANT_RLS_POLICY_SQL,
  TENANT_RLS_PREDICATE,
  tenantPredicate,
  selfPredicate,
  tenantRlsPolicy,
  type TenantRlsOptions,
} from './rls.js';

/**
 * Table definitions, as `schema.users`.
 *
 * Re-exported through a namespace rather than flat so a call site reads
 * `schema.refreshTokens` — at a glance that says "this is a table", which flat
 * exports stop conveying the moment there are eighty of them.
 */
export * as schema from './schema/index.js';

/**
 * A schema-level union that call sites take as a value, not through the `schema`
 * namespace: the session channel a refresh token is bound to (migration 0080).
 */
export type { SessionChannel } from './schema/identity.js';

/**
 * Drizzle's query helpers, re-exported.
 *
 * Feature code needs `eq`, `and`, `isNull` and friends to build a WHERE clause,
 * and importing them from `drizzle-orm` directly would be a second door into the
 * data layer that the guardrails do not watch. Routing them through here keeps
 * the rule simple: everything about the database comes from @taskflow/db.
 *
 * `sql` itself is exported for this package's own tests and for migrations. Its
 * use outside packages/db is a lint error — see `./expressions.js` for the named
 * alternatives, and add one there rather than widening the rule.
 */
export {
  eq,
  ne,
  and,
  or,
  not,
  exists,
  isNull,
  isNotNull,
  inArray,
  lt,
  lte,
  gt,
  gte,
  desc,
  asc,
  sql,
} from 'drizzle-orm';

/**
 * Self-joins — the same table joined twice under different names.
 *
 * Re-exported here rather than imported from `drizzle-orm/pg-core` at the call
 * site, for the reason the operators above are: `packages/db` is the ONE door
 * to the data layer, and a feature module reaching into drizzle directly is a
 * second one the guardrails do not watch. This is a query-BUILDING helper, not
 * a connection — it composes nothing that could bypass `withOrgScope`, so
 * exporting it widens the vocabulary without widening the access.
 *
 * The case that needed it: the org directory joins memberships once to COUNT
 * them and once more to find the owner, and one join cannot do both.
 */
export { alias } from 'drizzle-orm/pg-core';

/**
 * The type of a composed SQL expression.
 *
 * Exported as a TYPE only. Feature code needs it to name the return of a helper
 * that builds a predicate — `compiledPredicate` is the one that matters — and
 * importing it from 'drizzle-orm' directly would be a second door into the data
 * layer that the guardrails do not watch.
 */
export type { SQL } from 'drizzle-orm';

export {
  increment,
  decrement,
  coalesce,
  compiledPredicate,
  uuidArrayContains,
  sumWithFallback,
  sumColumn,
  countRows,
  minText,
  minUuid,
  coalesceColumns,
  minCoalesced,
  arrayLength,
  countDistinct,
  dateTrunc,
  minWhen,
  sumToMinutes,
  maxColumn,
  countFiltered,
} from './expressions.js';

/**
 * Enumerating tenants, for background jobs that visit every organization.
 *
 * Confined here because `withGlobalScope` is banned outside this package —
 * see `tenants.ts` on why the escape hatch is one function returning ids
 * rather than a scope a job holds open.
 */
export { listOrgIds } from './tenants.js';
