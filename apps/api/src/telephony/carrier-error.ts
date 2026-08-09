import { errors } from '@taskflow/contracts';
import { TwilioApiError } from '@taskflow/telephony';

/**
 * Translating a carrier refusal into this codebase's own error contract.
 *
 * ## Why this exists
 *
 * Every other way an outbound send can fail already answers precisely: the
 * suppression list is a FORBIDDEN, the spend cap and the geo allowlist are a
 * QUOTA_EXCEEDED, an unknown number is a NOT_FOUND. A refusal from the CARRIER
 * was the one that escaped as a raw exception, which tRPC classifies as
 * INTERNAL_SERVER_ERROR — so a destination that simply cannot receive SMS
 * produced a 500, "Something went wrong" in the UI, and a five-thousand-
 * character stack trace in the log with the actual answer (a four-digit code)
 * buried in the middle of it.
 *
 * That is not cosmetic, for the reason `builder.ts`'s own `toTrpcCode` gives
 * about domain failures: a 500 tells the client to retry, tells a load balancer
 * the instance is sick, and lights up every 5xx alert — here for a user typing
 * a landline into the To field. It also hides the genuine 500s among the noise.
 *
 * ## What may and may not be repeated back
 *
 * The message is OURS, selected by Twilio's numeric code. Twilio's own message
 * text is never propagated, for exactly the reason `twilio.ts` refuses to put
 * it in the thrown error: Twilio echoes request parameters back in error
 * payloads, and those parameters are phone numbers and message bodies — the
 * fields `REDACTION_PATHS` exists to keep out of logs. The code is an integer
 * from a published table and echoes nothing, so it is safe to surface, and
 * surfacing it is what lets a support conversation start at the answer instead
 * of at "it says something went wrong".
 *
 * ## Unrecognized failures are RETHROWN, not mapped
 *
 * A code that is not in the table below falls through unchanged and becomes an
 * INTERNAL_ERROR with its alert intact. The alternative — a default branch
 * turning everything into a tidy 400 — would silence genuine faults (a revoked
 * API credential, a malformed request we built) by dressing them as the user's
 * mistake, and the fix for those is ours, not theirs. A refusal is only
 * translated when we know what it means.
 */

/** Which side of the send a refusal is attributable to. */
type Attribution = 'to' | 'from';

/**
 * Two strings, because the client renders them in two places that never both
 * appear, and one string cannot serve both.
 *
 * `toast.failure` — what the SMS composer calls — passes the error through
 * `messageFor`, which returns `message` and nothing else; field details never
 * reach a toast. `ErrorText` does the opposite: when any field detail exists it
 * renders the details INSTEAD of the message, prefixed with the field name.
 *
 * So a single sentence written for the headline comes out of `ErrorText` as
 * "to: The carrier cannot deliver a message to that number from this number…",
 * with a label bolted onto a sentence that already names its own subject. The
 * headline has to stand alone; the reason has to read as a fragment ABOUT the
 * field it is labelled with. Same convention the Zod field errors follow —
 * `field-errors.ts` was built for "password: String must contain at least 12
 * character(s)", not for prose.
 */
interface CarrierRefusal {
  readonly attribution: Attribution;
  /** Stands alone. This is what a toast shows. */
  readonly message: string;
  /** Rendered after "to: " or "from: ". A fragment, not a sentence. */
  readonly reason: string;
}

/**
 * Twilio codes worth naming, at twilio.com/docs/api/errors/<code>.
 *
 * Split by attribution rather than listed flat, because the two need opposite
 * responses and the caller cannot tell them apart from a bare 400: a `to`
 * refusal means this recipient will never work and the user should try another
 * number, while a `from` refusal means every recipient is currently failing and
 * an admin has to change the number's carrier configuration. Answering both
 * with one message sends people to re-check the field that was fine.
 */
const REFUSALS: Readonly<Record<number, CarrierRefusal>> = {
  /* --- The destination ---------------------------------------------------- */
  21211: {
    attribution: 'to',
    message: 'That phone number is not a valid destination.',
    reason: 'Not a valid phone number.',
  },
  21214: {
    attribution: 'to',
    message: 'That phone number could not be reached.',
    reason: 'Could not be reached.',
  },
  21217: {
    attribution: 'to',
    message: 'That phone number is not a valid destination.',
    reason: 'Not a valid phone number.',
  },
  21612: {
    attribution: 'to',
    message:
      'The carrier cannot deliver a message to that number from this number. It may be a ' +
      'landline, or unreachable from this sending number.',
    reason: 'Not reachable by text from this sending number — it may be a landline.',
  },
  21614: {
    attribution: 'to',
    message: 'That phone number cannot receive text messages.',
    reason: 'Cannot receive text messages.',
  },

  /* --- The sending number, or the account behind it ----------------------- */
  21212: {
    attribution: 'from',
    message: 'That sending number is not valid.',
    reason: 'Not a valid sending number.',
  },
  21266: {
    attribution: 'from',
    message: 'A number cannot send a message to itself.',
    reason: 'Cannot send to itself.',
  },
  21408: {
    attribution: 'from',
    message:
      'This account is not enabled to send to that destination. Enable the region in the ' +
      "carrier console's messaging geographic permissions.",
    reason: "Not enabled for that destination's region.",
  },
  21606: {
    attribution: 'from',
    message: 'That number is not enabled for sending text messages.',
    reason: 'Not enabled for sending text messages.',
  },
  21611: {
    attribution: 'from',
    message:
      "That number's outbound queue is full. Messages are being sent faster than the " +
      'carrier will accept them.',
    reason: 'Outbound queue is full.',
  },
  30034: {
    attribution: 'from',
    message:
      'That number is not registered for A2P 10DLC messaging, which US carriers require. ' +
      'Complete the registration in the carrier console.',
    reason: 'Not registered for A2P 10DLC messaging.',
  },
};

/**
 * Codes meaning "the recipient told the carrier to stop".
 *
 * FORBIDDEN rather than VALIDATION_FAILED, matching what `sendSms` already
 * answers for our OWN suppression list — the two are the same refusal, and the
 * only difference is which side recorded the opt-out. This one exists because
 * an opt-out can be held by the carrier and not by us: a STOP sent to a number
 * before this org bought it, or one Twilio honored on a route we never saw.
 */
const OPTED_OUT = new Set([21610]);

/**
 * The carrier is unwell, or throttling us. Retrying is the right response, so
 * these must NOT become a 400 that tells the caller their input was wrong.
 */
const RETRYABLE = new Set([20429]);

/**
 * Maps a carrier failure onto an `AppError`, or rethrows it untouched.
 *
 * Declared `never` so it can be used directly as a `.catch` handler on a
 * provider call without widening the awaited type:
 *
 *     const result = await deps.telephony.sendSms({ ... }).catch(rethrowCarrierRefusal);
 */
export function rethrowCarrierRefusal(error: unknown): never {
  if (!(error instanceof TwilioApiError)) throw error;

  /* Ordered by specificity: a known code answers precisely, and only a failure
     we cannot name falls back to reasoning from the HTTP status. */
  const code = error.code;

  if (code !== undefined) {
    if (OPTED_OUT.has(code)) {
      throw errors.forbidden('That recipient has opted out of messages from this number.');
    }

    if (RETRYABLE.has(code)) {
      throw errors.serviceUnavailable(
        'The carrier is rate limiting this account. Please try again shortly.',
      );
    }

    const refusal = REFUSALS[code];
    if (refusal !== undefined) {
      /* `carrierCode` is a NUMBER on purpose. `fieldErrors` renders only the
         string-valued entries, so the code travels in the response for a
         support conversation to start from without rendering as a bogus
         "carrierCode: 21612" field under the input. */
      throw errors.validation(
        { [refusal.attribution]: refusal.reason, carrierCode: code },
        refusal.message,
      );
    }
  }

  /* A 5xx or a 429 with no code we recognize is still unambiguously not the
     caller's fault, and unambiguously worth retrying. Nothing else is: a 400 or
     403 we have no entry for is a request WE built wrongly or a credential
     problem, and both belong in the 500s where they will be noticed. */
  if (error.status === 429 || error.status >= 500) {
    throw errors.serviceUnavailable('The carrier is not responding. Please try again shortly.');
  }

  throw error;
}
