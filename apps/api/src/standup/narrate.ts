import type { KeyProvider, OrgId, RequestId, UserId } from '@taskflow/contracts';
import { completeGated } from '../ai/complete.js';
import { loadMembershipId } from '../ai/router.js';
import { resolveAiProvider } from '../ai/provider-resolver.js';
import type { StandupResult } from './standup.service.js';

/**
 * Narrating a standup's raw data into a short summary (ai/phase-15-ai-
 * copilot-and-permissions.md §5 — "AI narrates the raw list into a short
 * summary per person... reuses §2's provider... no new write path").
 *
 * A single `completeGated` call, not the §4 tool-calling loop
 * (`runAssistantTurn`): there is nothing for the model to DO here, only text
 * to produce from data this route already queried, so the tool-execution
 * machinery — authorization per tool, confirm-before-execute, the round
 * cap — has no work to do and would only add a network round trip for
 * nothing. `complete.ts`'s own header names `'standup'` as an expected
 * `feature` value for exactly this call.
 *
 * The model sees ONLY the already-authorized `StandupResult` this route
 * queried under the caller's own `project:read` — never a raw database read
 * of its own — so it can narrate no more than the person asking could
 * already see.
 */
export interface NarrateStandupDeps {
  readonly keys: KeyProvider;
}

export async function narrateStandup(
  deps: NarrateStandupDeps,
  actor: { readonly orgId: OrgId; readonly userId: UserId; readonly requestId: RequestId },
  standup: StandupResult,
): Promise<{ readonly summary: string }> {
  const [{ provider, providerName, model }, membershipId] = await Promise.all([
    resolveAiProvider(actor.orgId, deps.keys),
    loadMembershipId(actor.orgId, actor.userId),
  ]);

  const result = await completeGated(
    provider,
    { orgId: actor.orgId, userId: actor.userId, membershipId, requestId: actor.requestId },
    {
      feature: 'standup',
      providerName,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You write short, plain-language standup summaries from structured card data. ' +
            'For each person, mention what they finished, call out anything overdue, and keep ' +
            'it to one or two sentences per person. Do not invent facts not in the data. Do ' +
            'not use markdown headers or bullet lists — plain sentences, one paragraph per ' +
            'person, in the order given.',
        },
        { role: 'user', content: JSON.stringify(standup) },
      ],
      effort: 'low',
      maxOutputTokens: 800,
    },
  );

  return { summary: result.content };
}
