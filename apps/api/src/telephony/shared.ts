import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import type { Subject } from '@taskflow/policy';

/**
 * Shared plumbing for the telephony services (ai/phase-7-voice.md Wave 1).
 *
 * Deliberately thin compared with `docs/shared.ts` or `chat/shared.ts`, and
 * §6.3 says why: unlike Docs' tree-resolved grants, every telephony permission
 * is a FLAT role grant with no relationship-tuple or ancestor-walk component.
 * There is no `telephonyTarget()` here because there is nothing for one to
 * resolve — `can()`'s existing role-only path already produces a correct
 * decision trace with zero changes.
 *
 * Worth stating rather than leaving implied, so a future reader does not go
 * looking for a telephony-specific resolver that was never needed.
 */

export interface TelephonyActor {
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export function orgOf(actor: TelephonyActor): OrgId {
  return actor.subject.orgId;
}

export function userOf(actor: TelephonyActor): UserId {
  return actor.subject.userId;
}

export function envelopeOf(actor: TelephonyActor): {
  readonly orgId: OrgId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
} {
  return { orgId: actor.subject.orgId, actorId: actor.subject.userId, requestId: actor.requestId };
}

/**
 * The event context for something the CARRIER caused (§3.11).
 *
 * `actorId: null` is not a placeholder for a value we failed to find — it is the
 * accurate answer. An inbound call, a status callback, a recording notification:
 * no user of this system performed any of them, and attributing one to the
 * person who happened to own the number would put a false name in the audit log
 * for an action they did not take.
 *
 * `EventContext.actorId` is `UserId | null` rather than optional precisely so
 * this has to be stated rather than omitted.
 */
export function webhookContext(
  orgId: OrgId,
  requestId: string,
  actorId?: UserId,
): { readonly orgId: OrgId; readonly actorId: UserId | null; readonly requestId: RequestId } {
  return {
    orgId,
    actorId: actorId ?? null,
    requestId: unsafeAsId<'RequestId'>(requestId),
  };
}
