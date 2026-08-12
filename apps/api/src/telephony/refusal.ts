import { withOrgScope, outboxWriter } from '@taskflow/db';
import type { OutboundKind, TelephonyRefusal } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { spendLimitExceeded } from './events.js';
import { envelopeOf, orgOf, type TelephonyActor } from './shared.js';
import type { GateRefused } from './spend-gate.js';

/**
 * Emitting a gate refusal (ai/phase-7-voice.md §4).
 *
 * ## Why this is a shared function rather than two lines at each call site
 *
 * §4's argument for `spend.limit_exceeded` existing at all: "A spend cap that
 * only prevents the NEXT call is a control; one that also fires a typed,
 * outbox-carried event is a control someone can be notified about — which is the
 * difference between 'the system quietly stopped placing calls' and 'an admin
 * found out why within the hour.'"
 *
 * That only holds if EVERY refusal emits. Two obligations — throw an error,
 * write an event — at each of several call sites is a standing invitation to
 * satisfy the first and forget the second, and forgetting it produces a system
 * that fails silently in exactly the situation someone needed to hear about.
 * One function, called by every path that can refuse.
 *
 * The event carries no phone number, for the reason `events.ts` states: an
 * outbox payload is projected into the audit log, where `REDACTION_PATHS` never
 * runs.
 */
export async function emitRefusal(
  actor: TelephonyActor,
  decision: GateRefused,
  kind: OutboundKind,
  estimatedCents: number,
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        spendLimitExceeded,
        {
          reason: decision.reason,
          kind,
          estimatedCents,
          spentCents: decision.spentCents,
          capCents: decision.capCents,
        },
        envelopeOf(actor),
      ),
    ]);
  });
}

/**
 * The message shown to the caller.
 *
 * Deliberately vague about the geo allowlist. "That destination is not
 * permitted" tells a legitimate user what they need (this will not work) and
 * tells someone probing for allowed destinations nothing about WHICH rule
 * matched or where the boundary is — a message naming the country would turn
 * the refusal into an oracle for mapping the allowlist one call at a time.
 */
export function refusalMessage(reason: TelephonyRefusal): string {
  switch (reason) {
    case 'spend_cap_exceeded':
      return 'This organization has reached its telephony spend limit.';
    case 'destination_not_allowed':
      return 'That destination is not permitted.';
    case 'velocity_exceeded':
      return 'Too many calls or messages in a short period. Please wait and try again.';
    case 'org_suspended':
      return 'Telephony is disabled for this organization.';
    case 'no_subaccount':
      return 'Telephony is not set up for this organization yet.';
    case 'automation_budget_exceeded':
      /* Says "the rule's own allowance", not the org's number: a human who
         sees this on a run history row needs to know it is the automation
         budget that is gone, not the phone line. The org's real cap is
         reported by `spend_cap_exceeded`, which is the case they must not
         be confused with. */
      return 'This organization\'s automation telephony budget is exhausted.';
  }
}
