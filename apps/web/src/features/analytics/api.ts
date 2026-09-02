import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '@taskflow/client';

/**
 * Analytics query options (Phase 11).
 *
 * Every dashboard read, in one place — identical shape to telephony/api.ts.
 * `queryOptions` rather than hooks, `wire()` on every result.
 */

/* -------------------------------------------------------------------------- *
 * Types
 * -------------------------------------------------------------------------- */

interface Outputs {
  velocity: Awaited<ReturnType<typeof api.analytics.velocity.query>>;
  burndown: Awaited<ReturnType<typeof api.analytics.burndown.query>>;
  cfd: Awaited<ReturnType<typeof api.analytics.cfd.query>>;
  cycleTime: Awaited<ReturnType<typeof api.analytics.cycleTime.query>>;
  workload: Awaited<ReturnType<typeof api.analytics.workload.query>>;
  volume: Awaited<ReturnType<typeof api.analytics.volume.query>>;
  spend: Awaited<ReturnType<typeof api.analytics.spend.query>>;
  status: Awaited<ReturnType<typeof api.analytics.status.query>>;
}

export type VelocityPoint = Wire<Outputs['velocity']>[number];
export type BurndownPoint = Wire<Outputs['burndown']>[number];
export type CfdPoint = Wire<Outputs['cfd']>[number];
export type CycleTimeResult = Wire<Outputs['cycleTime']>;
export type WorkloadEntry = Wire<Outputs['workload']>[number];
export type VolumePoint = Wire<Outputs['volume']>[number];
export type SpendRow = Wire<Outputs['spend']>[number];
export type AnalyticsStatus = Wire<Outputs['status']>;

/* -------------------------------------------------------------------------- *
 * Query helpers
 * -------------------------------------------------------------------------- */

function dateRange(start: Date, end: Date) {
  return { startDate: start, endDate: end };
}

/** §3.1 — Velocity: done cards per day. */
export function velocityQuery(start: Date, end: Date, boardId?: string) {
  return queryOptions({
    queryKey: keys.analyticsVelocity(start.toISOString(), end.toISOString(), boardId),
    queryFn: async () =>
      wire(await api.analytics.velocity.query({ ...dateRange(start, end), boardId })),
  });
}

/** §3.2 — Burndown: remaining work over time. */
export function burndownQuery(projectId: string, start: Date, end: Date, sprintId?: string) {
  return queryOptions({
    queryKey: keys.analyticsBurndown(projectId, start.toISOString(), end.toISOString(), sprintId),
    queryFn: async () =>
      wire(
        await api.analytics.burndown.query({
          projectId,
          ...dateRange(start, end),
          ...(sprintId !== undefined ? { sprintId } : {}),
        }),
      ),
  });
}

/** §3.3 — CFD: cumulative flow diagram. */
export function cfdQuery(boardId: string, start: Date, end: Date) {
  return queryOptions({
    queryKey: keys.analyticsCfd(boardId, start.toISOString(), end.toISOString()),
    queryFn: async () => wire(await api.analytics.cfd.query({ boardId, ...dateRange(start, end) })),
  });
}

/** §3.4 — Cycle Time: median + p85. */
export function cycleTimeQuery(projectId?: string, boardId?: string) {
  return queryOptions({
    queryKey: keys.analyticsCycleTime(projectId, boardId),
    queryFn: async () =>
      wire(
        await api.analytics.cycleTime.query({
          ...(projectId !== undefined ? { projectId } : {}),
          ...(boardId !== undefined ? { boardId } : {}),
        }),
      ),
  });
}

/** §3.5 — Workload: open cards per assignee. */
export function workloadQuery(boardId?: string) {
  return queryOptions({
    queryKey: keys.analyticsWorkload(boardId),
    queryFn: async () =>
      wire(
        await api.analytics.workload.query({
          ...(boardId !== undefined ? { boardId } : {}),
        }),
      ),
  });
}

/** §3.6 — Volume: messages, calls, in-app calls per day. */
export function volumeQuery(start: Date, end: Date) {
  return queryOptions({
    queryKey: keys.analyticsVolume(start.toISOString(), end.toISOString()),
    queryFn: async () => wire(await api.analytics.volume.query(dateRange(start, end))),
  });
}

/** §3.6 — Spend: comms cost attribution. */
export function spendQuery(sinceDays = 30) {
  return queryOptions({
    queryKey: keys.analyticsSpend(sinceDays),
    queryFn: async () => wire(await api.analytics.spend.query({ sinceDays })),
  });
}

/**
 * §6 — Status: staleness and rollup freshness.
 *
 * Overrides the global focus/reconnect refetch defaults (`packages/client`)
 * deliberately: this route can trigger a real rollup recompute server-side
 * (see `analytics/router.ts`'s `status` handler) when an org's rollups
 * haven't caught up yet, and the global defaults would refire it every time
 * the tab regains focus. The server-side single-flight guard
 * (`refreshOrgOnce`) makes concurrent calls safe either way, but there is no
 * reason to keep re-asking a question whose answer changes at most once per
 * worker refresh interval.
 */
export function statusQuery() {
  return queryOptions({
    queryKey: keys.analyticsStatus(),
    queryFn: async () => wire(await api.analytics.status.query()),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
