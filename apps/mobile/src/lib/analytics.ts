import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Analytics queries (Phase 11, mobile §11).
 *
 * Derived from the SAME `AppRouter` as apps/web — never hand-declared — the
 * same `Wire<T>` convention every other mobile type uses. Query keys mirror
 * web's `apps/web/src/features/analytics/api.ts` for cache consistency if
 * the same data is ever fetched on both platforms during a session.
 *
 * No `queryOptions` helpers here: mobile's analytics screens are simple
 * enough that inline `queryKey`/`queryFn` pairs keep the call site and the
 * key co-located, unlike the web side where the same query is reused across
 * five dashboard panels.
 */

/* -------------------------------------------------------------------------- *
 * Types — derived from the live client
 * -------------------------------------------------------------------------- */

type VelocityOutput = Wire<Awaited<ReturnType<MobileTRPCClient['analytics']['velocity']['query']>>>;
export type VelocityPoint = VelocityOutput[number];

type BurndownOutput = Wire<Awaited<ReturnType<MobileTRPCClient['analytics']['burndown']['query']>>>;
export type BurndownPoint = BurndownOutput[number];

type CycleTimeOutput = Wire<
  Awaited<ReturnType<MobileTRPCClient['analytics']['cycleTime']['query']>>
>;
export type CycleTimeResult = CycleTimeOutput;

type WorkloadOutput = Wire<Awaited<ReturnType<MobileTRPCClient['analytics']['workload']['query']>>>;
export type WorkloadEntry = WorkloadOutput[number];

type VolumeOutput = Wire<Awaited<ReturnType<MobileTRPCClient['analytics']['volume']['query']>>>;
export type VolumePoint = VolumeOutput[number];

/* -------------------------------------------------------------------------- *
 * Query keys
 * -------------------------------------------------------------------------- */

export function velocityKey(start: string, end: string, boardId?: string) {
  return ['analytics.velocity', start, end, boardId] as const;
}

export function burndownKey(projectId: string, start: string, end: string) {
  return ['analytics.burndown', projectId, start, end] as const;
}

export function cycleTimeKey(projectId?: string, boardId?: string) {
  return ['analytics.cycleTime', projectId, boardId] as const;
}

export function workloadKey(boardId?: string) {
  return ['analytics.workload', boardId] as const;
}

export function volumeKey(start: string, end: string) {
  return ['analytics.volume', start, end] as const;
}

/* -------------------------------------------------------------------------- *
 * Date helpers
 * -------------------------------------------------------------------------- */

/** A 30-day range ending now — the default window for velocity/volume. */
export function last30Days(): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end };
}

/** A 90-day range ending now — used for burndown/sprint views. */
export function last90Days(): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return { start, end };
}
