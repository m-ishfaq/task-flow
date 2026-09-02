import {
  and,
  eq,
  asc,
  isNotNull,
  withOrgScope,
  withAuditScope,
  schema,
  type OrgId,
} from '@taskflow/db';
import { dateTrunc, countDistinct, minWhen, countRows, sumToMinutes } from '@taskflow/db';

/**
 * Analytics rollup refresh (Phase 11, ai/phase-11-analytics.md §1, §6).
 *
 * Computes pre-computed aggregations from `analytics.card_transitions` into
 * the rollup tables. The worker loop calls `refreshAllOrgs()` on a timer;
 * dashboard queries read the rollup tables instead of computing on-the-fly.
 *
 * §6 properties:
 * - Refreshes only active orgs (respects identity.orgs.status).
 * - Runs in apps/worker, not apps/api — latency-insensitive work.
 * - Staleness is displayed via the analytics.status route.
 *
 * ## How refresh works
 *
 * For each active org, the refresh:
 * 1. Deletes existing rollup rows for the org (fresh computation).
 * 2. Computes velocity, CFD, cycle time, and volume aggregations.
 * 3. Inserts the new rollup rows.
 *
 * This is a full recompute per org, not an incremental update. The cost is
 * acceptable because:
 * - card_transitions is small (one row per status change).
 * - The refresh runs on a timer (default 5 minutes), not per-request.
 * - A full recompute is correct by construction; incremental updates carry
 *   the risk of drift that §1 warns about.
 *
 * The raw SQL ban (guardrail 7) applies here as everywhere in apps/api.
 * All SQL expressions use named helpers from packages/db/expressions.ts.
 * The only exception is the `sql` template used for the CFD walk, which
 * belongs in packages/db — see the expressions module.
 */

export interface RefreshResult {
  readonly orgsRefreshed: number;
  readonly velocityRows: number;
  readonly cfdRows: number;
  readonly cycleTimeRows: number;
  readonly volumeRows: number;
  readonly burndownRows: number;
}

/* ------------------------------------------------------------------------ *
 * Result types for queries using SQL expression helpers with .as().         *
 * Drizzle can't infer the aliased types through custom SQL expressions,    *
 * so each query needs an explicit result interface.                         *
 * ------------------------------------------------------------------------ */

interface VelocityRow {
  boardId: string;
  day: string;
  doneCount: string;
}

interface BoardIdRow {
  boardId: string;
}

interface CfdTransitionRow {
  day: string;
  fromCategory: string | null;
  toCategory: string;
  count: string;
}

interface CycleTimeRow {
  cardId: string;
  boardId: string;
  projectId: string;
  firstActiveAt: unknown;
  firstDoneAt: unknown;
}

interface VolumeRow {
  day: string;
  count: string;
  durationMin?: number;
}

interface BurndownTransitionRow {
  day: string;
  projectId: string;
  fromCategory: string | null;
  toCategory: string;
  count: string;
}

/**
 * Refreshes rollups for a single org.
 *
 * Called per-org by `refreshAllOrgs`. Runs under `withOrgScope` so RLS
 * on both card_transitions and the rollup tables handles isolation.
 *
 * Exported for testing — the public `refreshAllOrgs` discovers orgs through the
 * audit role (see its own note), which a unit test would otherwise have to set
 * up a second pool for. Tests call this directly, per-org, to skip that step.
 */
export async function refreshOrg(orgId: OrgId): Promise<Omit<RefreshResult, 'orgsRefreshed'>> {
  return withOrgScope(orgId, async (tx) => {
    // Clear existing rollup data for this org.
    await tx.delete(schema.rollupVelocity).where(eq(schema.rollupVelocity.orgId, orgId));
    await tx.delete(schema.rollupCfd).where(eq(schema.rollupCfd.orgId, orgId));
    await tx.delete(schema.rollupCycleTime).where(eq(schema.rollupCycleTime.orgId, orgId));
    await tx.delete(schema.rollupVolume).where(eq(schema.rollupVolume.orgId, orgId));
    await tx.delete(schema.rollupBurndown).where(eq(schema.rollupBurndown.orgId, orgId));

    // ── Velocity (§3.1): done transitions per board per day ──────────

    const velocityRows = (await tx
      .select({
        boardId: schema.cardTransitions.boardId,
        day: dateTrunc(schema.cardTransitions.occurredAt).as('day'),
        doneCount: countRows(schema.cardTransitions.id).as('done_count'),
      })
      .from(schema.cardTransitions)
      .where(
        and(eq(schema.cardTransitions.orgId, orgId), eq(schema.cardTransitions.toCategory, 'done')),
      )
      .groupBy(
        schema.cardTransitions.boardId,
        dateTrunc(schema.cardTransitions.occurredAt),
      )) as unknown as VelocityRow[];

    for (const row of velocityRows) {
      await tx.insert(schema.rollupVelocity).values({
        orgId,
        boardId: row.boardId,
        day: row.day,
        doneCount: Number(row.doneCount),
      });
    }

    // ── CFD (§3.3): category counts per board per day ────────────────
    //
    // Walk transitions forward from a starting snapshot per board.
    // This is the most complex rollup: it needs to accumulate daily deltas.

    const boards = (await tx
      .selectDistinct({ boardId: schema.cardTransitions.boardId })
      .from(schema.cardTransitions)
      .where(eq(schema.cardTransitions.orgId, orgId))) as unknown as BoardIdRow[];

    let cfdRowCount = 0;

    for (const { boardId } of boards) {
      // Walk transitions forward from zero. Creation transitions (fromCategory
      // = null) add to the target; all others subtract from source and add
      // to target. Starting at zero is correct because the fact table is
      // append-only and covers every transition — there is no state before
      // the first row.
      const running: Record<string, number> = { not_started: 0, active: 0, done: 0 };

      // Daily transitions for this board.
      const transitions = (await tx
        .select({
          day: dateTrunc(schema.cardTransitions.occurredAt).as('day'),
          fromCategory: schema.cardTransitions.fromCategory,
          toCategory: schema.cardTransitions.toCategory,
          count: countDistinct(schema.cardTransitions.cardId).as('count'),
        })
        .from(schema.cardTransitions)
        .where(
          and(eq(schema.cardTransitions.orgId, orgId), eq(schema.cardTransitions.boardId, boardId)),
        )
        .groupBy(
          dateTrunc(schema.cardTransitions.occurredAt),
          schema.cardTransitions.fromCategory,
          schema.cardTransitions.toCategory,
        )
        .orderBy(
          asc(dateTrunc(schema.cardTransitions.occurredAt)),
        )) as unknown as CfdTransitionRow[];

      let currentDate = '';

      for (const row of transitions) {
        if (row.day !== currentDate) {
          // Write the previous day's snapshot.
          if (currentDate !== '') {
            for (const [cat, count] of Object.entries(running)) {
              await tx.insert(schema.rollupCfd).values({
                orgId,
                boardId,
                day: currentDate,
                category: cat,
                cardCount: count,
              });
              cfdRowCount += 1;
            }
          }
          currentDate = row.day;
        }

        // Apply the delta.
        if (row.fromCategory !== null && row.fromCategory in running) {
          const prev = running[row.fromCategory];
          if (prev !== undefined) running[row.fromCategory] = Math.max(0, prev - Number(row.count));
        }
        if (row.toCategory in running) {
          const prev = running[row.toCategory];
          if (prev !== undefined) running[row.toCategory] = prev + Number(row.count);
        }
      }

      // Write the last day.
      if (currentDate !== '') {
        for (const [cat, count] of Object.entries(running)) {
          await tx.insert(schema.rollupCfd).values({
            orgId,
            boardId,
            day: currentDate,
            category: cat,
            cardCount: count,
          });
          cfdRowCount += 1;
        }
      }
    }

    // ── Cycle Time (§3.4): per-card time from active to done ─────────

    const activeEq = eq(schema.cardTransitions.toCategory, 'active');
    const doneEq = eq(schema.cardTransitions.toCategory, 'done');

    const cycleTimeRows = (await tx
      .select({
        cardId: schema.cardTransitions.cardId,
        boardId: schema.cardTransitions.boardId,
        projectId: schema.cardTransitions.projectId,
        firstActiveAt: minWhen(schema.cardTransitions.occurredAt, activeEq).as('first_active'),
        firstDoneAt: minWhen(schema.cardTransitions.occurredAt, doneEq).as('first_done'),
      })
      .from(schema.cardTransitions)
      .where(eq(schema.cardTransitions.orgId, orgId))
      .groupBy(
        schema.cardTransitions.cardId,
        schema.cardTransitions.boardId,
        schema.cardTransitions.projectId,
      )
      .having(
        isNotNull(minWhen(schema.cardTransitions.occurredAt, activeEq)),
      )) as unknown as CycleTimeRow[];

    let cycleTimeInserts = 0;
    for (const row of cycleTimeRows) {
      // MIN(CASE WHEN ...) returns raw values from Postgres — strings,
      // not Dates, because Drizzle's type parsers don't reach inside
      // aggregate expressions. Parse explicitly.
      const rawActive = row.firstActiveAt as string | null;
      const rawDone = row.firstDoneAt as string | null;
      const activeTime = rawActive !== null ? new Date(rawActive) : null;
      const doneTime = rawDone !== null ? new Date(rawDone) : null;
      const cycleHours =
        activeTime && doneTime
          ? (doneTime.getTime() - activeTime.getTime()) / (1000 * 60 * 60)
          : null;

      await tx.insert(schema.rollupCycleTime).values({
        orgId,
        cardId: row.cardId,
        boardId: row.boardId,
        projectId: row.projectId,
        cycleTimeHours: cycleHours,
        firstActiveAt: activeTime,
        firstDoneAt: doneTime,
      });
      cycleTimeInserts += 1;
    }

    // ── Volume (§3.6): daily message/call counts ─────────────────────

    const messages = (await tx
      .select({
        day: dateTrunc(schema.messages.createdAt).as('day'),
        count: countRows(schema.messages.id).as('count'),
      })
      .from(schema.messages)
      .where(eq(schema.messages.orgId, orgId))
      .groupBy(dateTrunc(schema.messages.createdAt))) as unknown as VolumeRow[];

    const calls = (await tx
      .select({
        day: dateTrunc(schema.calls.createdAt).as('day'),
        count: countRows(schema.calls.id).as('count'),
        durationMin: sumToMinutes(schema.calls.durationSeconds).as('duration_min'),
      })
      .from(schema.calls)
      .where(eq(schema.calls.orgId, orgId))
      .groupBy(dateTrunc(schema.calls.createdAt))) as unknown as VolumeRow[];

    const inAppCalls = (await tx
      .select({
        day: dateTrunc(schema.rtcSessions.createdAt).as('day'),
        count: countRows(schema.rtcSessions.id).as('count'),
      })
      .from(schema.rtcSessions)
      .where(eq(schema.rtcSessions.orgId, orgId))
      .groupBy(dateTrunc(schema.rtcSessions.createdAt))) as unknown as VolumeRow[];

    // Merge into a single map.
    const volumeByDay = new Map<
      string,
      {
        messageCount: number;
        callCount: number;
        callDurationMin: number;
        inAppCallCount: number;
      }
    >();

    for (const row of messages) {
      const key = row.day;
      const existing = volumeByDay.get(key);
      if (existing) {
        existing.messageCount = Number(row.count);
      } else {
        volumeByDay.set(key, {
          messageCount: Number(row.count),
          callCount: 0,
          callDurationMin: 0,
          inAppCallCount: 0,
        });
      }
    }

    for (const row of calls) {
      const key = row.day;
      const existing = volumeByDay.get(key);
      if (existing) {
        existing.callCount = Number(row.count);
        existing.callDurationMin = row.durationMin ?? 0;
      } else {
        volumeByDay.set(key, {
          messageCount: 0,
          callCount: Number(row.count),
          callDurationMin: row.durationMin ?? 0,
          inAppCallCount: 0,
        });
      }
    }

    for (const row of inAppCalls) {
      const key = row.day;
      const existing = volumeByDay.get(key);
      if (existing) {
        existing.inAppCallCount = Number(row.count);
      } else {
        volumeByDay.set(key, {
          messageCount: 0,
          callCount: 0,
          callDurationMin: 0,
          inAppCallCount: Number(row.count),
        });
      }
    }

    let volumeInserts = 0;
    for (const [day, data] of volumeByDay) {
      await tx.insert(schema.rollupVolume).values({
        orgId,
        day,
        ...data,
      });
      volumeInserts += 1;
    }

    // ── Burndown (§3.2): daily done/undone per project ──────────────

    const burndownTransitions = (await tx
      .select({
        day: dateTrunc(schema.cardTransitions.occurredAt).as('day'),
        projectId: schema.cardTransitions.projectId,
        fromCategory: schema.cardTransitions.fromCategory,
        toCategory: schema.cardTransitions.toCategory,
        count: countDistinct(schema.cardTransitions.cardId).as('count'),
      })
      .from(schema.cardTransitions)
      .where(eq(schema.cardTransitions.orgId, orgId))
      .groupBy(
        dateTrunc(schema.cardTransitions.occurredAt),
        schema.cardTransitions.projectId,
        schema.cardTransitions.fromCategory,
        schema.cardTransitions.toCategory,
      )
      .orderBy(
        asc(dateTrunc(schema.cardTransitions.occurredAt)),
      )) as unknown as BurndownTransitionRow[];

    // Aggregate done/undone per (project, day).
    const burndownMap = new Map<string, { doneCount: number; undoneCount: number }>();

    for (const row of burndownTransitions) {
      const key = `${row.projectId}::${row.day}`;
      let entry = burndownMap.get(key);
      if (!entry) {
        entry = { doneCount: 0, undoneCount: 0 };
        burndownMap.set(key, entry);
      }
      const count = Number(row.count);
      if (row.toCategory === 'done') entry.doneCount += count;
      if (row.fromCategory === 'done') entry.undoneCount += count;
    }

    let burndownInserts = 0;
    for (const [key, data] of burndownMap) {
      const parts = key.split('::');
      const projectId = parts[0];
      const day = parts[1];
      if (projectId === undefined || day === undefined) continue;
      await tx.insert(schema.rollupBurndown).values({
        orgId,
        projectId,
        day,
        doneCount: data.doneCount,
        undoneCount: data.undoneCount,
      });
      burndownInserts += 1;
    }

    return {
      velocityRows: velocityRows.length,
      cfdRows: cfdRowCount,
      cycleTimeRows: cycleTimeInserts,
      volumeRows: volumeInserts,
      burndownRows: burndownInserts,
    };
  });
}

/**
 * Refreshes rollups for all active orgs.
 *
 * Called by the worker loop on a timer. Iterates over every org, skips
 * suspended ones (§6), and refreshes each org's rollups independently.
 *
 * A failed org refresh is logged but does not stop the loop — the next
 * tick will retry. This is the same "logged, never rethrown" pattern
 * every other consumer loop in this codebase uses.
 */
export async function refreshAllOrgs(logger: {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}): Promise<RefreshResult> {
  // Enumerate orgs through the AUDIT role, not the app role. identity.orgs has
  // no RLS policy admitting taskflow_app with app.org_id cleared (migration
  // 0004), so withGlobalScope/listOrgIds returns ZERO — which silently made this
  // whole loop a no-op. Migration 0037 grants taskflow_audit an explicit
  // `USING (true)` read of (id, status) — the same grant the notification sweeps
  // use to visit every tenant. Reading status here also lets us skip suspended
  // orgs (§6) without a second per-org query. The analytics projection relay
  // already runs under withAuditScope, so the module's cross-tenant reads stay
  // on one non-app role.
  const allOrgs = await withAuditScope(async (tx) =>
    tx.select({ id: schema.orgs.id, status: schema.orgs.status }).from(schema.orgs),
  );

  let orgsRefreshed = 0;
  let totalVelocity = 0;
  let totalCfd = 0;
  let totalCycleTime = 0;
  let totalVolume = 0;
  let totalBurndown = 0;

  for (const org of allOrgs) {
    // Skip suspended orgs (§6): a frozen tenant's rollups are left as they were.
    if (org.status !== 'active') continue;

    try {
      const result = await refreshOrg(org.id as OrgId);
      orgsRefreshed += 1;
      totalVelocity += result.velocityRows;
      totalCfd += result.cfdRows;
      totalCycleTime += result.cycleTimeRows;
      totalVolume += result.volumeRows;
      totalBurndown += result.burndownRows;
    } catch (error) {
      logger.error({ err: error, orgId: org.id }, 'analytics refresh failed for org');
    }
  }

  if (orgsRefreshed > 0) {
    logger.info(
      {
        orgsRefreshed,
        velocityRows: totalVelocity,
        cfdRows: totalCfd,
        cycleTimeRows: totalCycleTime,
        volumeRows: totalVolume,
        burndownRows: totalBurndown,
      },
      'analytics rollups refreshed',
    );
  }

  return {
    orgsRefreshed,
    velocityRows: totalVelocity,
    cfdRows: totalCfd,
    cycleTimeRows: totalCycleTime,
    volumeRows: totalVolume,
    burndownRows: totalBurndown,
  };
}

/**
 * De-dupes concurrent `refreshOrg` callers for the same org into one shared
 * recompute — the `platform-admin/flag-evaluator.ts` single-flight shape,
 * one org at a time instead of one global snapshot.
 *
 * `analytics.status` calls this (never `refreshOrg` directly) because it is
 * reached from a QUERY, which a client can retry, refetch on focus, or fire
 * from several open tabs at once. Without this, each of those concurrent
 * calls would independently DELETE-then-INSERT the same org's rollup rows —
 * redundant work at best, lock contention on the rollup tables at worst.
 * `refreshAllOrgs`'s own timer tick does not go through this: it already
 * visits each org at most once per tick, so there is nothing to de-dupe.
 */
const refreshInFlight = new Map<OrgId, Promise<Omit<RefreshResult, 'orgsRefreshed'>>>();

export async function refreshOrgOnce(orgId: OrgId): Promise<Omit<RefreshResult, 'orgsRefreshed'>> {
  const existing = refreshInFlight.get(orgId);
  if (existing) return existing;

  const promise = refreshOrg(orgId).finally(() => {
    refreshInFlight.delete(orgId);
  });
  refreshInFlight.set(orgId, promise);
  return promise;
}
