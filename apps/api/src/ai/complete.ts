import { outboxWriter, withOrgScope } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  errors,
  type AiCompletionResult,
  type AiMessage,
  type AiProvider,
  type AiToolDefinition,
  type MembershipId,
  type OrgId,
  type RequestId,
  type UserId,
} from '@taskflow/contracts';
import { aiBudgetExceeded } from './events.js';
import { costCentsFor } from './rates.js';
import { checkAiCompletionAllowed, recordAiUsage } from './spend-gate.js';

/**
 * THE one call site permitted to call `AiProvider.complete` from a
 * budget-aware caller (§3.2's own doctrine — see `spend-gate.ts`'s header).
 * Every future §4 tool-calling loop routes its completions through here
 * rather than reaching a resolved `AiProvider` directly, the same way every
 * outbound telephony path routes through `checkOutboundAllowed` rather than
 * calling `TelephonyProvider` itself.
 */

export interface AiCompletionActor {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly membershipId: MembershipId;
  readonly requestId: RequestId;
}

export interface CompleteGatedRequest {
  /** e.g. 'standup', 'pr-review' — see `ai.usage_ledger.feature`'s own comment. */
  readonly feature: string;
  readonly providerName: string;
  readonly model: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolDefinition[] | undefined;
  readonly effort?: 'low' | 'medium' | 'high' | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export async function completeGated(
  provider: AiProvider,
  actor: AiCompletionActor,
  request: CompleteGatedRequest,
): Promise<AiCompletionResult> {
  const decision = await checkAiCompletionAllowed(actor.orgId);

  if (!decision.allowed) {
    /* Refused BEFORE `provider.complete` is ever called — the property this
       whole module exists to prove, asserted in `complete.test.ts` against a
       `FakeAiProvider` whose `calls` array stays empty. */
    await withOrgScope(actor.orgId, async (tx) => {
      await outboxWriter.append(tx, [
        createEvent(
          aiBudgetExceeded,
          {
            reason: decision.reason,
            spentCents: decision.spentCents,
            budgetCents: decision.budgetCents ?? 0,
          },
          { orgId: actor.orgId, actorId: actor.userId, requestId: actor.requestId },
        ),
      ]);
    });

    throw errors.quotaExceeded(
      decision.reason === 'org_suspended'
        ? 'This organization is suspended.'
        : 'This organization has reached its monthly AI budget.',
    );
  }

  const result = await provider.complete({
    orgId: actor.orgId,
    model: request.model,
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
  });

  const costCents = costCentsFor(request.model, result.usage);

  /* Same transaction as nothing else — unlike `placeCall`, there is no
     sibling row (a `comms.calls` record) this write must commit alongside.
     Still opened fresh rather than reused, matching `recordSpend`'s own
     "write in the caller's transaction" contract for a future caller that
     DOES have one (e.g. a standup run row, §5). */
  await withOrgScope(actor.orgId, async (tx) => {
    await recordAiUsage(
      tx,
      actor.orgId,
      {
        id: newId<'AiUsageLedgerId'>(),
        membershipId: actor.membershipId,
        feature: request.feature,
        provider: request.providerName,
        model: request.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costCents,
      },
      { orgId: actor.orgId, actorId: actor.userId, requestId: actor.requestId },
    );
  });

  return result;
}
