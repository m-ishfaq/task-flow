import { queryOptions } from '@tanstack/react-query';
import type { ProjectId } from '@taskflow/contracts';
import { wire, type Wire } from '@taskflow/client';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';

/**
 * The standup view's reads (ai/phase-15-ai-copilot-and-permissions.md §5).
 *
 * `queryOptions` rather than a hook, same as every other feature's `api.ts` —
 * this is the definition a component, a prefetch, or an invalidation all
 * share, and a hook can only be called from the first of those.
 */

type Outputs = Awaited<ReturnType<typeof api.standup.query.query>>;

export type StandupCard = Wire<Outputs>['members'][number]['yesterday'][number];
export type StandupMember = Wire<Outputs>['members'][number];
export type StandupResult = Wire<Outputs>;

/** Defaults to 24h, matching the route's own default — "since the last standup". */
export function standupQuery(orgId: string, projectId: ProjectId, sinceHours = 24) {
  return queryOptions({
    queryKey: keys.standup(orgId, projectId, sinceHours),
    queryFn: async () => wire(await api.standup.query.query({ projectId, sinceHours })),
    enabled: orgId !== '',
  });
}

export interface StandupCallout {
  /** One short team-wide paragraph — never per-member; see `narrate.ts`'s
      own header on why per-member AI lines were dropped once `query` began
      returning real Yesterday/Today/Overdue/Urgent card lists directly. */
  readonly callout: string;
}

/**
 * Narration is a mutation, not a query — it is a priced, budget-gated
 * completion (`completeGated`), not an idempotent read, so a component must
 * ask for it explicitly rather than have it fire on mount or refetch.
 *
 * The whole standup screen renders from `standupQuery` alone with no AI
 * call — `narrate` adds only an optional team-level callout on top.
 */
export async function narrateStandup(
  projectId: ProjectId,
  sinceHours: number,
): Promise<StandupCallout> {
  return api.standup.narrate.mutate({ projectId, sinceHours });
}

/**
 * "Email me this project's standup" (migration 0108). Same `project:read`
 * floor as `standupQuery` above — reaching this page at all already proves
 * that, so the toggle needs no extra capability check of its own.
 */
export function standupSubscriptionQuery(orgId: string, projectId: ProjectId) {
  return queryOptions({
    queryKey: keys.standupSubscription(orgId, projectId),
    queryFn: async () => api.standup.subscription.query({ projectId }),
    enabled: orgId !== '',
  });
}

export async function subscribeToStandup(projectId: ProjectId): Promise<{ subscribed: true }> {
  return api.standup.subscribe.mutate({ projectId });
}

export async function unsubscribeFromStandup(
  projectId: ProjectId,
): Promise<{ unsubscribed: boolean }> {
  return api.standup.unsubscribe.mutate({ projectId });
}
