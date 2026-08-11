import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { wire } from '../../lib/wire.js';
import { keys } from '../../lib/query.js';

/**
 * Automation queries (ai/phase-10-automation.md Wave 1).
 *
 * `conditionBroken` comes from the SERVER, which re-parses each stored
 * condition on every list — the client does not re-derive it. Two parsers
 * deciding independently whether a rule is usable is exactly the drift
 * `lib/wire.ts` exists to prevent one level down.
 */

export function automationsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.automations(orgId),
    queryFn: async () => wire(await api.automation.list.query({})),
  });
}

/**
 * Run history — the org tier (§9 decision 8).
 *
 * `staleTime` is short because this is the screen someone stares at while
 * waiting to see whether their rule fired. The engine polls the outbox on its
 * own interval, so a run appears a second or two after the action that caused
 * it, and a long stale window would make a working rule look broken.
 */
export function automationRunsQuery(orgId: string, automationId?: string) {
  return queryOptions({
    queryKey: keys.automationRuns(orgId, automationId ?? null),
    queryFn: async () =>
      wire(
        await api.automation.runs.query(
          automationId === undefined ? { limit: 50 } : { automationId, limit: 50 },
        ),
      ),
    staleTime: 5_000,
  });
}

/**
 * The webhook registry (Wave 2) — feeds both the management section and the
 * rule builder's webhook picker. `enabled` is the endpoint kill switch; the
 * picker filters on it, the management section renders it.
 */
export function webhooksQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.webhooks(orgId),
    queryFn: async () => wire(await api.automation.webhooks.list.query({})),
  });
}

/** Recent delivery history for one endpoint — the "did it go out" read. */
export function webhookDeliveriesQuery(orgId: string, webhookId: string) {
  return queryOptions({
    queryKey: keys.webhookDeliveries(orgId, webhookId),
    queryFn: async () => wire(await api.automation.webhooks.deliveries.query({ webhookId })),
  });
}
