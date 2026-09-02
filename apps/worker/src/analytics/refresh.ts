import { refreshAllOrgs } from '@taskflow/api/analytics/refresh';
import type { Logger } from '@taskflow/observability';

/**
 * Analytics rollup refresh loop (Phase 11, ai/phase-11-analytics.md §6).
 *
 * Runs in apps/worker on a timer. Calls `refreshAllOrgs` which computes
 * pre-computed aggregations from card_transitions into the rollup tables.
 *
 * §6 properties:
 * - Runs in apps/worker, not apps/api — latency-insensitive work.
 * - Refreshes only active orgs (respects identity.orgs.status).
 * - Staleness is displayed via the analytics.status route.
 *
 * This loop has no dedicated database pool — it runs under the ordinary
 * `taskflow_app` connection (`withOrgScope` per org), because the refresh
 * needs to read card_transitions (app role) AND write rollup tables (same
 * role). A dedicated role would buy nothing here.
 */

export function startAnalyticsRefresh(options: {
  readonly logger: Logger;
  readonly intervalMs: number;
}): { readonly stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      await refreshAllOrgs(options.logger);
    } catch (error) {
      // Logged, never rethrown — the identical reasoning every other
      // consumer loop in this codebase gives: a transient blip must not
      // take the process down, and the next tick retries.
      options.logger.error({ err: error }, 'analytics refresh tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
