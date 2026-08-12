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

/**
 * Every programmatic-access token in the org (Wave 3, §6) — feeds the
 * management section. `tokenPrefix` distinguishes two tokens both called
 * "CI" without the server ever exposing a hash.
 */
export function apiTokensQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.apiTokens(orgId),
    queryFn: async () => wire(await api.apiToken.list.query({})),
  });
}

/**
 * Whether the cost-bearing telephony actions exist in the builder (§5.5) —
 * the server's answer to the same env flag the write boundary is built from,
 * so the builder cannot offer a rule the server will refuse to save.
 */
export function automationCapabilitiesQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.automationCapabilities(orgId),
    queryFn: async () => wire(await api.automation.capabilities.query({})),
  });
}

/**
 * The scope checklist's options — the caller's held permissions, answered by
 * the same live `can()` the mint route validates with, so the form can never
 * offer a scope the server will refuse.
 */
export function heldApiTokenScopesQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.apiTokenScopes(orgId),
    queryFn: async () => wire(await api.apiToken.heldScopes.query({})),
  });
}

/**
 * Every connector row in the org (Wave 4 slice 2, §7) — the Integrations
 * tab's list. Feeds both the management section and, indirectly, the rule
 * builder's connector picker (slice 4).
 */
export function integrationsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.integrations(orgId),
    queryFn: async () => wire(await api.automation.integration.list.query({})),
  });
}

/**
 * Which connector providers this server has credentials for, plus the webhook
 * origin — read before any connect button renders, so an unconfigured
 * provider's button never appears (the `auth.oauth.providers` precedent).
 */
export function integrationCapabilitiesQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.integrationCapabilities(orgId),
    queryFn: async () => wire(await api.automation.integration.capabilities.query({})),
  });
}

/** Recent delivery history for one endpoint — the "did it go out" read. */
export function webhookDeliveriesQuery(orgId: string, webhookId: string) {
  return queryOptions({
    queryKey: keys.webhookDeliveries(orgId, webhookId),
    queryFn: async () => wire(await api.automation.webhooks.deliveries.query({ webhookId })),
  });
}
