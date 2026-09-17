import { and, countRows, desc, eq, lt, or, schema, withPlatformAdminScope } from '@taskflow/db';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The operations dashboard's read side — the console's view of
 * `platform.operational_events` (migration 0061).
 *
 * Read as `taskflow_platform_admin`, which migration 0061 grants a direct
 * SELECT on this table — the "write role differs from read role" split
 * `operator_audit_log` already established, not `withOpsEventScope`, which
 * is the WRITER role and lint-restricted to `packages/db` besides.
 *
 * Same keyset shape as `listOrgs`/`listUsers`/`listBilling`: `(occurredAt,
 * id) DESC`, reusing `pagination.ts`'s generically-named cursor helpers —
 * see that file's own header on why truncating to millisecond precision
 * cannot skip or repeat a row.
 */

export interface OperationalEventRow {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string;
  readonly target: string | null;
  readonly detail: unknown;
  readonly occurredAt: Date;
}

function toNumber(val: unknown): number {
  return Number(val ?? 0) || 0;
}

export async function listOperationalEvents(
  operator: PlatformOperator,
  input: {
    readonly cursor: string | null;
    readonly limit: number;
    /** Null means every kind — the console's default view. */
    readonly kind: string | null;
  },
): Promise<{
  readonly events: readonly OperationalEventRow[];
  readonly nextCursor: string | null;
  readonly summary: {
    readonly totalEvents: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly byKind: readonly { readonly kind: string; readonly count: number }[];
  };
}> {
  const cursor = parseCreatedCursor(input.cursor);

  const kindCondition = input.kind === null ? undefined : eq(schema.operationalEvents.kind, input.kind);

  const [rows, summaryRows] = await withPlatformAdminScope(async (tx) => {
    const paginatedQuery = tx
      .select({
        id: schema.operationalEvents.id,
        kind: schema.operationalEvents.kind,
        outcome: schema.operationalEvents.outcome,
        target: schema.operationalEvents.target,
        detail: schema.operationalEvents.detail,
        occurredAt: schema.operationalEvents.occurredAt,
      })
      .from(schema.operationalEvents)
      .orderBy(desc(schema.operationalEvents.occurredAt), desc(schema.operationalEvents.id))
      .limit(input.limit + 1);

    const summaryQuery = tx
      .select({
        kind: schema.operationalEvents.kind,
        outcome: schema.operationalEvents.outcome,
        count: countRows(schema.operationalEvents.id),
      })
      .from(schema.operationalEvents)
      .groupBy(schema.operationalEvents.kind, schema.operationalEvents.outcome);

    const paginatedConditions = [
      kindCondition,
      cursor === null
        ? undefined
        : or(
            lt(schema.operationalEvents.occurredAt, cursor.createdAt),
            and(
              eq(schema.operationalEvents.occurredAt, cursor.createdAt),
              lt(schema.operationalEvents.id, cursor.rowId),
            ),
          ),
    ].filter((condition) => condition !== undefined);

    if (paginatedConditions.length > 0) {
      paginatedQuery.where(and(...paginatedConditions));
    }

    const summaryConditions = [kindCondition].filter(
      (condition) => condition !== undefined,
    );

    if (summaryConditions.length > 0) {
      summaryQuery.where(and(...summaryConditions));
    }

    const [paginated, summary] = await Promise.all([paginatedQuery, summaryQuery]);
    return [paginated, summary] as const;
  });

  /* Every operator action lands in the global chain — including a read
     (§5's acceptance criterion, the same discipline every other list route
     in this module follows). Done AFTER the read succeeds, so a failed read
     leaves no row claiming it happened. */
  await recordOperatorAction(
    operator.userId,
    'operations.list',
    input.kind === null ? null : { kind: input.kind },
  );

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  /* Build summary from the grouped aggregation — collapse (kind, outcome)
     rows into totals and per-kind counts. */
  let totalEvents = 0;
  let successCount = 0;
  let failureCount = 0;
  const kindMap = new Map<string, number>();
  for (const row of summaryRows) {
    const n = toNumber(row.count);
    totalEvents += n;
    if (row.outcome === 'success') {
      successCount += n;
    } else {
      failureCount += n;
    }
    kindMap.set(row.kind, (kindMap.get(row.kind) ?? 0) + n);
  }
  const byKind = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  return {
    events: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      outcome: row.outcome,
      target: row.target,
      detail: row.detail,
      occurredAt: row.occurredAt,
    })),
    nextCursor:
      hasMore && last !== undefined ? encodeCreatedCursor(last.occurredAt, last.id) : null,
    summary: { totalEvents, successCount, failureCount, byKind },
  };
}
