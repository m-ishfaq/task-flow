import { and, desc, eq, lt, or, schema, withPlatformAdminScope } from '@taskflow/db';
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
}> {
  const cursor = parseCreatedCursor(input.cursor);

  const rows = await withPlatformAdminScope(async (tx) => {
    const query = tx
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

    const conditions = [
      input.kind === null ? undefined : eq(schema.operationalEvents.kind, input.kind),
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

    if (conditions.length > 0) {
      query.where(and(...conditions));
    }
    return query;
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
  };
}
