import {
  and,
  eq,
  gte,
  lte,
  gt,
  asc,
  isNull,
  inArray,
  withOrgScope,
  schema,
  countDistinct,
  sumColumn,
  dateTrunc,
  countRows,
  arrayLength,
} from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';

/**
 * Analytics dashboard queries (Phase 11, ai/phase-11-analytics.md §3).
 *
 * All dashboards read from pre-computed rollup tables — the spec-prescribed
 * architecture (§1, §6): "Materialized views refreshed on a schedule, never
 * live aggregation over transactional tables."
 *
 * The rollup tables are regular tables with RLS (not materialized views)
 * because materialized views cannot have row-level security. They are
 * refreshed on a schedule by the worker loop (apps/worker/src/analytics/refresh.ts).
 *
 * §3.2 (Burndown) date-range mode reads from rollup_burndown. Sprint mode
 * still reads card_transitions directly because sprint membership is dynamic.
 *
 * §3.5 (Workload) is the one exception: it queries the transactional
 * `work.cards` table directly because it is a question about the PRESENT.
 *
 * Every query runs under `withOrgScope`, so RLS handles tenant isolation.
 */

/* -------------------------------------------------------------------------- *
 * §3.1 — Velocity (from rollup_velocity)
 * -------------------------------------------------------------------------- */

export interface VelocityPoint {
  date: string;
  count: number;
}

export async function queryVelocity(
  orgId: OrgId,
  opts: {
    startDate: Date;
    endDate: Date;
    boardId?: string;
  },
): Promise<VelocityPoint[]> {
  return withOrgScope(orgId, async (tx) => {
    const startStr = opts.startDate.toISOString().slice(0, 10);
    const endStr = opts.endDate.toISOString().slice(0, 10);

    if (opts.boardId !== undefined) {
      // Per-board: read directly from rollup.
      const rows = await tx
        .select({
          day: schema.rollupVelocity.day,
          doneCount: schema.rollupVelocity.doneCount,
        })
        .from(schema.rollupVelocity)
        .where(
          and(
            eq(schema.rollupVelocity.orgId, orgId),
            eq(schema.rollupVelocity.boardId, opts.boardId),
            gte(schema.rollupVelocity.day, startStr),
            lte(schema.rollupVelocity.day, endStr),
          ),
        )
        .orderBy(asc(schema.rollupVelocity.day));

      return rows.map((row) => ({
        date: row.day,
        count: row.doneCount,
      }));
    }

    // All boards: aggregate across boards per day.
    const rows = await tx
      .select({
        day: schema.rollupVelocity.day,
        doneCount: sumColumn(schema.rollupVelocity.doneCount).as('done_count'),
      })
      .from(schema.rollupVelocity)
      .where(
        and(
          eq(schema.rollupVelocity.orgId, orgId),
          gte(schema.rollupVelocity.day, startStr),
          lte(schema.rollupVelocity.day, endStr),
        ),
      )
      .groupBy(schema.rollupVelocity.day)
      .orderBy(asc(schema.rollupVelocity.day));

    return rows.map((row) => ({
      date: row.day,
      count: Number(row.doneCount),
    }));
  });
}

/* -------------------------------------------------------------------------- *
 * §3.2 — Burndown (rollup_burndown for date-range, card_transitions for sprint)
 * -------------------------------------------------------------------------- */

export interface BurndownPoint {
  date: string;
  remaining: number;
}

export async function queryBurndown(
  orgId: OrgId,
  opts: {
    projectId: string;
    startDate: Date;
    endDate: Date;
    sprintId?: string;
  },
): Promise<BurndownPoint[]> {
  return withOrgScope(orgId, async (tx) => {
    // Sprint mode: card_transitions directly, because sprint membership
    // is dynamic and cannot be pre-computed into a rollup.
    if (opts.sprintId !== undefined) {
      return queryBurndownFromTransactions(tx, orgId, { ...opts, sprintId: opts.sprintId });
    }

    // Date-range mode: read from rollup_burndown.
    return queryBurndownFromRollup(tx, orgId, opts);
  });
}

/** Date-range burndown from pre-computed rollup. */
async function queryBurndownFromRollup(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  opts: { projectId: string; startDate: Date; endDate: Date },
): Promise<BurndownPoint[]> {
  const startStr = opts.startDate.toISOString().slice(0, 10);
  const endStr = opts.endDate.toISOString().slice(0, 10);

  // Total distinct cards in scope at sprint start — from card_transitions
  // (the rollup doesn't store this; it only stores daily done/undone).
  const sprintCards = await tx
    .select({ count: countDistinct(schema.cardTransitions.cardId).as('count') })
    .from(schema.cardTransitions)
    .where(
      and(
        eq(schema.cardTransitions.projectId, opts.projectId),
        lte(schema.cardTransitions.occurredAt, opts.startDate),
      ),
    );

  const totalCards = Number(sprintCards[0]?.count ?? '0');

  // Daily done/undone from rollup.
  const rollupRows = await tx
    .select({
      day: schema.rollupBurndown.day,
      doneCount: schema.rollupBurndown.doneCount,
      undoneCount: schema.rollupBurndown.undoneCount,
    })
    .from(schema.rollupBurndown)
    .where(
      and(
        eq(schema.rollupBurndown.orgId, orgId),
        eq(schema.rollupBurndown.projectId, opts.projectId),
        gte(schema.rollupBurndown.day, startStr),
        lte(schema.rollupBurndown.day, endStr),
      ),
    )
    .orderBy(asc(schema.rollupBurndown.day));

  const dailyDone = new Map<string, number>();
  const dailyUndone = new Map<string, number>();
  for (const row of rollupRows) {
    dailyDone.set(row.day, row.doneCount);
    dailyUndone.set(row.day, row.undoneCount);
  }

  const result: BurndownPoint[] = [];
  let doneTotal = 0;

  const start = new Date(opts.startDate);
  const end = new Date(opts.endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    doneTotal += dailyDone.get(dateStr) ?? 0;
    const undone = dailyUndone.get(dateStr) ?? 0;
    result.push({
      date: dateStr,
      remaining: Math.max(0, totalCards + undone - doneTotal),
    });
  }

  return result;
}

/** Sprint burndown from card_transitions (dynamic sprint membership). */
async function queryBurndownFromTransactions(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  opts: { projectId: string; startDate: Date; endDate: Date; sprintId: string },
): Promise<BurndownPoint[]> {
  const sprintCardIds = await tx
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.projectId, opts.projectId),
        eq(schema.cards.sprintId, opts.sprintId),
      ),
    );

  const cardIds = sprintCardIds.map((r) => r.id);
  if (cardIds.length === 0) {
    return [];
  }

  const cardFilter = and(
    eq(schema.cardTransitions.projectId, opts.projectId),
    inArray(schema.cardTransitions.cardId, cardIds),
  );

  // Total distinct CARDS in scope at sprint start.
  const sprintCards = await tx
    .select({ count: countDistinct(schema.cardTransitions.cardId).as('count') })
    .from(schema.cardTransitions)
    .where(and(cardFilter, lte(schema.cardTransitions.occurredAt, opts.startDate)));

  const totalCards = Number(sprintCards[0]?.count ?? '0');

  // Daily transitions.
  // Drizzle can't infer result types through SQL expression helpers with .as(),
  // so the query result is cast to a typed interface.
  interface BurndownTransitionRow {
    date: string;
    fromCategory: string | null;
    toCategory: string;
    count: string;
  }

  const transitions = await tx
    .select({
      date: dateTrunc(schema.cardTransitions.occurredAt),
      fromCategory: schema.cardTransitions.fromCategory,
      toCategory: schema.cardTransitions.toCategory,
      count: countRows(schema.cardTransitions.id),
    })
    .from(schema.cardTransitions)
    .where(
      and(
        cardFilter,
        gte(schema.cardTransitions.occurredAt, opts.startDate),
        lte(schema.cardTransitions.occurredAt, opts.endDate),
      ),
    )
    .groupBy(
      dateTrunc(schema.cardTransitions.occurredAt),
      schema.cardTransitions.fromCategory,
      schema.cardTransitions.toCategory,
    )
    .orderBy(asc(dateTrunc(schema.cardTransitions.occurredAt))) as unknown as BurndownTransitionRow[];

  const dailyDone = new Map<string, number>();
  const dailyUndone = new Map<string, number>();

  for (const row of transitions) {
    const count = Number(row.count);
    if (row.toCategory === 'done') {
      dailyDone.set(row.date, (dailyDone.get(row.date) ?? 0) + count);
    }
    if (row.fromCategory === 'done') {
      dailyUndone.set(row.date, (dailyUndone.get(row.date) ?? 0) + count);
    }
  }

  const result: BurndownPoint[] = [];
  let doneTotal = 0;

  const start = new Date(opts.startDate);
  const end = new Date(opts.endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    doneTotal += dailyDone.get(dateStr) ?? 0;
    const undone = dailyUndone.get(dateStr) ?? 0;
    result.push({
      date: dateStr,
      remaining: Math.max(0, totalCards + undone - doneTotal),
    });
  }

  return result;
}

/* -------------------------------------------------------------------------- *
 * §3.3 — Cumulative Flow (from rollup_cfd)
 * -------------------------------------------------------------------------- */

export interface CfdPoint {
  date: string;
  notStarted: number;
  active: number;
  done: number;
}

export async function queryCfd(
  orgId: OrgId,
  opts: {
    boardId: string;
    startDate: Date;
    endDate: Date;
  },
): Promise<CfdPoint[]> {
  return withOrgScope(orgId, async (tx) => {
    const startStr = opts.startDate.toISOString().slice(0, 10);
    const endStr = opts.endDate.toISOString().slice(0, 10);

    const rows = await tx
      .select({
        day: schema.rollupCfd.day,
        category: schema.rollupCfd.category,
        cardCount: schema.rollupCfd.cardCount,
      })
      .from(schema.rollupCfd)
      .where(
        and(
          eq(schema.rollupCfd.orgId, orgId),
          eq(schema.rollupCfd.boardId, opts.boardId),
          gte(schema.rollupCfd.day, startStr),
          lte(schema.rollupCfd.day, endStr),
        ),
      )
      .orderBy(asc(schema.rollupCfd.day));

    const byDate = new Map<string, { notStarted: number; active: number; done: number }>();

    for (const row of rows) {
      let entry = byDate.get(row.day);
      if (!entry) {
        entry = { notStarted: 0, active: 0, done: 0 };
        byDate.set(row.day, entry);
      }
      if (row.category === 'not_started') entry.notStarted = row.cardCount;
      else if (row.category === 'active') entry.active = row.cardCount;
      else if (row.category === 'done') entry.done = row.cardCount;
    }

    // Fill in the full date range with carry-forward.
    const result: CfdPoint[] = [];
    let lastNotStarted = 0;
    let lastActive = 0;
    let lastDone = 0;

    const start = new Date(opts.startDate);
    const end = new Date(opts.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const existing = byDate.get(ds);
      if (existing) {
        lastNotStarted = existing.notStarted;
        lastActive = existing.active;
        lastDone = existing.done;
      }
      result.push({
        date: ds,
        notStarted: lastNotStarted,
        active: lastActive,
        done: lastDone,
      });
    }

    return result;
  });
}

/* -------------------------------------------------------------------------- *
 * §3.4 — Cycle Time (from rollup_cycle_time)
 * -------------------------------------------------------------------------- */

export interface CycleTimeResult {
  medianHours: number;
  p85Hours: number;
  count: number;
  openCount: number;
}

export async function queryCycleTime(
  orgId: OrgId,
  opts: {
    projectId?: string;
    boardId?: string;
  },
): Promise<CycleTimeResult> {
  return withOrgScope(orgId, async (tx) => {
    const whereFilters = [
      ...(opts.boardId !== undefined
        ? [eq(schema.rollupCycleTime.boardId, opts.boardId)]
        : opts.projectId !== undefined
          ? [eq(schema.rollupCycleTime.projectId, opts.projectId)]
          : []),
    ];

    const rows = await tx
      .select({
        cycleTimeHours: schema.rollupCycleTime.cycleTimeHours,
      })
      .from(schema.rollupCycleTime)
      .where(whereFilters.length > 0 ? and(...whereFilters) : undefined);

    const cycleTimes: number[] = [];
    let openCount = 0;

    for (const row of rows) {
      if (row.cycleTimeHours === null) {
        openCount += 1;
      } else if (row.cycleTimeHours >= 0) {
        cycleTimes.push(row.cycleTimeHours);
      }
    }

    if (cycleTimes.length === 0) {
      return { medianHours: 0, p85Hours: 0, count: 0, openCount };
    }

    cycleTimes.sort((a, b) => a - b);
    const medianIdx = Math.floor((cycleTimes.length - 1) / 2);
    const p85Idx = Math.min(cycleTimes.length - 1, Math.floor(cycleTimes.length * 0.85));

    return {
      medianHours: cycleTimes[medianIdx] ?? 0,
      p85Hours: cycleTimes[p85Idx] ?? 0,
      count: cycleTimes.length,
      openCount,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * §3.5 — Workload (from work.cards — present state, no rollup)
 * -------------------------------------------------------------------------- */

export interface WorkloadEntry {
  userId: string;
  cardCount: number;
}

export async function queryWorkload(
  orgId: OrgId,
  opts: {
    boardId?: string;
  },
): Promise<WorkloadEntry[]> {
  return withOrgScope(orgId, async (tx) => {
    const whereFilters = [
      isNull(schema.cards.archivedAt),
      isNull(schema.cards.deletedAt),
      gt(arrayLength(schema.cards.assigneeIds), 0),
      ...(opts.boardId !== undefined
        ? [eq(schema.cards.boardId, opts.boardId)]
        : []),
    ];

    const rows = await tx
      .select({
        assigneeIds: schema.cards.assigneeIds,
      })
      .from(schema.cards)
      .where(and(...whereFilters));

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const userId of row.assigneeIds) {
        counts.set(userId, (counts.get(userId) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([userId, cardCount]) => ({ userId, cardCount }))
      .sort((a, b) => b.cardCount - a.cardCount);
  });
}

/* -------------------------------------------------------------------------- *
 * §3.6 — Volume (from rollup_volume)
 * -------------------------------------------------------------------------- */

export interface VolumePoint {
  date: string;
  messages: number;
  calls: number;
  callDurationMinutes: number;
  inAppCalls: number;
}

export async function queryVolume(
  orgId: OrgId,
  opts: {
    startDate: Date;
    endDate: Date;
  },
): Promise<VolumePoint[]> {
  return withOrgScope(orgId, async (tx) => {
    const startStr = opts.startDate.toISOString().slice(0, 10);
    const endStr = opts.endDate.toISOString().slice(0, 10);

    const rows = await tx
      .select({
        day: schema.rollupVolume.day,
        messageCount: schema.rollupVolume.messageCount,
        callCount: schema.rollupVolume.callCount,
        callDurationMin: schema.rollupVolume.callDurationMin,
        inAppCallCount: schema.rollupVolume.inAppCallCount,
      })
      .from(schema.rollupVolume)
      .where(
        and(
          eq(schema.rollupVolume.orgId, orgId),
          gte(schema.rollupVolume.day, startStr),
          lte(schema.rollupVolume.day, endStr),
        ),
      )
      .orderBy(asc(schema.rollupVolume.day));

    const byDate = new Map<string, VolumePoint>();
    const start = new Date(opts.startDate);
    const end = new Date(opts.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      byDate.set(ds, {
        date: ds,
        messages: 0,
        calls: 0,
        callDurationMinutes: 0,
        inAppCalls: 0,
      });
    }

    for (const row of rows) {
      const point = byDate.get(row.day);
      if (point !== undefined) {
        point.messages = row.messageCount;
        point.calls = row.callCount;
        point.callDurationMinutes = row.callDurationMin;
        point.inAppCalls = row.inAppCallCount;
      }
    }

    return [...byDate.values()];
  });
}
