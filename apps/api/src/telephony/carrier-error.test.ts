import { describe, expect, it } from 'vitest';
import { isAppError } from '@taskflow/contracts';
import { TwilioApiError } from '@taskflow/telephony';
import { rethrowCarrierRefusal } from './carrier-error.js';

/**
 * Pure — no database, no provider. The whole surface is a classification, and
 * the assertions worth having are about which failures are translated and,
 * more importantly, which are NOT.
 */

function refusal(status: number, code?: number): TwilioApiError {
  return new TwilioApiError(
    'POST',
    'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json',
    status,
    code,
  );
}

/**
 * No `throw` after the try/catch to guard against a silent return: the compiler
 * already proves there cannot be one, because `rethrowCarrierRefusal` is
 * declared `never`. Writing the guard anyway is TS7027 unreachable code.
 */
function thrownBy(error: unknown): unknown {
  try {
    rethrowCarrierRefusal(error);
  } catch (caught) {
    return caught;
  }
}

describe('rethrowCarrierRefusal', () => {
  it('maps an unroutable destination to a validation failure naming the To field', () => {
    /* 21612 — the one that sent this whole change: it arrived as a 500 and
       "Something went wrong", for a destination that simply cannot receive a
       message from this number. */
    const error = thrownBy(refusal(400, 21612));

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details?.['to']).toEqual(expect.any(String));
    expect(error.details?.['from']).toBeUndefined();
  });

  it('writes the field reason and the headline for their two different renderers', () => {
    /* The client shows one or the other, never both: `toast.failure` renders
       `message` alone, and `ErrorText` renders the field details INSTEAD of the
       message, prefixed with the field name. The first version of this reused
       one sentence for both, so the composer showed "to: The carrier cannot
       deliver a message to that number from this number…" — a field label
       bolted onto a sentence that already names its subject.

       Asserted for EVERY code rather than one, because the table is where the
       next entry gets added and copying the headline into `reason` is the
       obvious way to add it. */
    for (const code of [
      21211, 21214, 21217, 21612, 21614, 21212, 21266, 21408, 21606, 21611, 30034,
    ]) {
      const error = thrownBy(refusal(400, code));
      if (!isAppError(error)) throw new Error(`code ${String(code)} was not mapped`);

      const reason = error.details?.['to'] ?? error.details?.['from'];
      expect(reason, `code ${String(code)} has no field reason`).toEqual(expect.any(String));
      expect(reason, `code ${String(code)} reuses its headline as the field reason`).not.toBe(
        error.message,
      );
    }
  });

  it('keeps the carrier code out of the rendered field list', () => {
    /* `fieldErrors` renders every STRING-valued entry in `details` under its
       key. A `carrierCode` string would therefore render as a field called
       "carrierCode" under the phone input. As a number it stays in the response
       for support to read and out of the UI. */
    const error = thrownBy(refusal(400, 21612));

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.details?.['carrierCode']).toBe(21612);
  });

  it('attributes a sending-number problem to From rather than To', () => {
    /* 30034 is unregistered A2P 10DLC — every recipient is failing and no
       amount of retyping the destination helps. A single message for both
       sides would send an admin to check the field that was fine. */
    const error = thrownBy(refusal(400, 30034));

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.details?.['from']).toEqual(expect.any(String));
    expect(error.details?.['to']).toBeUndefined();
  });

  it('answers a carrier-held opt-out exactly as the suppression list does', () => {
    const error = thrownBy(refusal(400, 21610));

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe('FORBIDDEN');
  });

  it('keeps a carrier outage retryable rather than blaming the input', () => {
    for (const error of [thrownBy(refusal(503)), thrownBy(refusal(429))]) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) continue;
      expect(error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('never repeats the carrier’s own message text back to the caller', () => {
    /* `twilio.ts` deliberately keeps Twilio's `message` out of the thrown error
       because Twilio echoes phone numbers and message bodies in it. This is the
       second place that could undo it, by passing the carrier's string through
       as our own — so the assertion is that our message is OURS. */
    const error = thrownBy(refusal(400, 21612));

    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.message).not.toContain('Twilio');
    expect(error.message).not.toContain('api.twilio.com');
    expect(error.message).not.toMatch(/\+[0-9]{4,}/);
  });

  it('rethrows an UNRECOGNIZED carrier code untouched, so it keeps its alert', () => {
    /* The important negative. A default branch that tidied every 4xx into a 400
       would dress our own faults — a malformed request, a revoked credential —
       as the user's mistake, and those need to be noticed. */
    const original = refusal(403, 20003);
    expect(thrownBy(original)).toBe(original);
  });

  it('rethrows anything that is not a carrier error at all', () => {
    const original = new Error('connection reset');
    expect(thrownBy(original)).toBe(original);
  });
});
