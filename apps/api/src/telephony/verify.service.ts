import { withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PhoneNumber } from '@taskflow/contracts';
import type { VerificationChannel } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { verificationFailed, verificationStarted, verificationSucceeded } from './events.js';
import { emitRefusal, refusalMessage } from './refusal.js';
import { checkOutboundAllowed, notifySpendThresholds, recordSpend } from './spend-gate.js';
import { envelopeOf, orgOf, userOf, type TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';

/**
 * Twilio Verify (ai/phase-7-voice.md §3.12) — a second, narrower use of the
 * SAME `TelephonyProvider` every other file here uses, gated by the identical
 * spend/geo/velocity controls as an ordinary call or SMS. §3.3 is explicit
 * that a verification code is not exempt from the fraud controls just because
 * identity, rather than Voice & Messaging, is asking for one.
 *
 * ## This has no caller yet, and that is deliberate
 *
 * PLAN.md §3.4 defers MFA enforcement itself — TOTP and this SMS/call fallback
 * — to Phase 12; `apps/api/src/identity` has no second-factor login step to
 * wire this into today, so `ai/phase-7-voice.md` §3.12's framing of "the
 * existing MFA path" as this feature's consumer does not match what is
 * actually in `apps/api/src/identity` yet. Wave 1 shipped webhook signature
 * verification the same way — "with no route registered yet that uses it for
 * anything real" — because the part that is expensive to get wrong and cheap
 * to build early is the fraud-control wiring, not the caller. When Phase 12
 * adds a login-time SMS step, it calls the two functions below; it does not
 * reimplement the gate, and it must not skip the velocity check on
 * `checkPhoneVerification` — see that function's own comment.
 */

export interface VerificationOutcome {
  readonly approved: boolean;
}

export async function startPhoneVerification(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: { readonly to: PhoneNumber; readonly channel: VerificationChannel },
): Promise<{ readonly sid: string }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  const estimatedCents = await deps.telephony.estimateCostCents({
    kind: 'verification',
    to: input.to,
  });

  /* THE gate — identical to `placeCall`/`sendSms`. A verification code sent
     to a premium-rate destination, or past the org's spend cap, is exactly
     the toll-fraud pattern the gate exists to stop; asking is not a special
     case. */
  const decision = await checkOutboundAllowed(
    { orgId, userId, kind: 'verification', to: input.to, estimatedCents },
    { defaultCapCents: deps.defaultSpendCapCents },
  );

  if (!decision.allowed) {
    await emitRefusal(actor, decision, 'verification', estimatedCents);
    throw errors.quotaExceeded(refusalMessage(decision.reason));
  }

  const result = await deps.telephony.startVerification({ to: input.to, channel: input.channel });

  await withOrgScope(orgId, async (tx) => {
    await recordSpend(
      tx,
      orgId,
      {
        id: newId<'SpendLedgerId'>(),
        kind: 'verification',
        estimatedCents: result.costCents,
        providerSid: result.sid,
        decision,
      },
      envelopeOf(actor),
    );

    await outboxWriter.append(tx, [
      createEvent(verificationStarted, { channel: input.channel }, envelopeOf(actor)),
    ]);
  });

  /* The usage alert, AFTER the commit — see `notifySpendThresholds`. */
  await notifySpendThresholds(orgId, decision, deps.mail);

  return { sid: result.sid };
}

/**
 * Checks a submitted code.
 *
 * ## Deliberately NOT re-run through `checkOutboundAllowed`
 *
 * Checking a code sends nothing to the carrier that costs money — there is no
 * `estimateCostCents` figure for it and nothing for the spend ledger to
 * record — so the outbound gate has nothing to decide here.
 *
 * That is not the same as "no rate limit belongs here." Repeatedly guessing a
 * six-digit code is the attack this endpoint exists to resist, and Twilio's
 * own Verify service locks a verification SID out after a small number of
 * wrong attempts — this function relies on that rather than duplicating it,
 * the same division of labour `checkOutboundAllowed`'s velocity limiter has
 * with the spend ledger it backstops. A Phase 12 caller wiring this into a
 * real login step MUST still apply its own per-user attempt throttle at the
 * point it calls this — `SlidingWindowLimiter`, the same primitive
 * `spend-gate.ts` and Phase 1's login lockout already use — because a login
 * form calling this in a loop with no throttle of its own is a brute force
 * against Twilio's lockout instead of ours, and the moment that lockout
 * clears (per-SID, not per-user), the guesser gets another full budget.
 */
export async function checkPhoneVerification(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: { readonly to: PhoneNumber; readonly code: string },
): Promise<VerificationOutcome> {
  const orgId = orgOf(actor);
  const result = await deps.telephony.checkVerification({ to: input.to, code: input.code });

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        result.approved ? verificationSucceeded : verificationFailed,
        {},
        envelopeOf(actor),
      ),
    ]);
  });

  return { approved: result.approved };
}
