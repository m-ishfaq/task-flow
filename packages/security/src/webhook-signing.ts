import { createHmac } from 'node:crypto';
import { secureEqual } from './random.js';

/**
 * Outbound webhook signing (ai/phase-10-automation.md §5).
 *
 * The mirror image of `twilio-signature.ts`, which verifies THEM: that file
 * recomputes the signature Twilio sent and compares; this one computes the
 * signature WE send so the receiver can do the same. Same primitive — HMAC
 * keyed by a shared secret — opposite direction.
 *
 * ## Why this lives in packages/security
 *
 * Guardrail 5: this signs requests leaving the deployment. `node:crypto` is
 * banned outside this package, so the one primitive a receiver's trust of our
 * webhooks rests on gets the one auditable file per primitive.
 *
 * ## The scheme
 *
 *     X-TaskFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t.<body>")>
 *
 *   - The timestamp is in the payload, so a receiver can reject stale
 *     signatures without a shared clock beyond seconds — the same reason
 *     Stripe's and GitHub's webhook signatures carry one.
 *   - The body is the EXACT bytes sent, as the receiver received them. A
 *     receiver that re-serializes JSON before verifying will fail; the
 *     documented contract is "verify against the raw body".
 *   - HMAC-SHA256 rather than SHA-1 because nothing external constrains us
 *     (Twilio signs with SHA-1 and a verifier may not "upgrade" — see that
 *     file's header). We define this side, so we define the algorithm.
 *
 * The secret is the `tf_whs` token minted at webhook creation
 * (`tokens.ts`), stored encrypted at rest and shared once with the org so
 * they can configure their receiver.
 */

/**
 * Builds the `X-TaskFlow-Signature` header value for a body.
 *
 * `body` is the exact UTF-8 string that will be sent. Callers must pass the
 * literal bytes — if the fetch layer re-serializes, the signature is over a
 * different string than the receiver verifies.
 */
export function buildWebhookSignature(
  secret: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): string {
  const timestamp = String(timestampSeconds);
  const digest = createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.${body}`, 'utf8'))
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Verifies an `X-TaskFlow-Signature` header — the check the RECEIVER performs.
 *
 * Exported so the suite can prove the round trip with the real primitive
 * rather than stubbing it: a signing test whose verify side is mocked asserts
 * that signing works on trusted input, which is the one case it is not
 * defending against.
 *
 * Constant-time comparison (`secureEqual`), for the same reason
 * `verifyTwilioSignature` uses it: a byte-by-byte `===` on a value the
 * receiver does not control would leak the valid signature for a chosen body
 * one character at a time.
 */
export function verifyWebhookSignature(options: {
  readonly secret: string;
  readonly body: string;
  readonly signature: string;
  /** How old a signature may be before it is refused. */
  readonly maxAgeSeconds: number;
  readonly now?: number;
}): boolean {
  if (options.secret.length === 0) return false;
  if (options.signature.length === 0) return false;

  const match = /^t=(\d+),v1=([0-9a-f]+)$/i.exec(options.signature);
  /* Optional chaining collapses the null check into the member access — the
     refusal is identical to an explicit `match === null` test.

     This comment used to claim the two capture groups were "guarded
     independently so a truncated header cannot slip past one guard". They are
     not: `||` short-circuits, so by the time the second operand runs `match`
     is already narrowed non-null, and the second `?.` does nothing. The regex
     is anchored and both groups are required, so a truncated header fails to
     match at all and neither guard is what saves it. Behaviour is correct;
     the explanation was describing a mechanism that is not here. */
  if (match?.[1] === undefined || match[2] === undefined) return false;

  const timestamp = Number(match[1]);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > options.maxAgeSeconds) {
    return false;
  }

  const expected = buildWebhookSignature(options.secret, options.body, timestamp);
  return secureEqual(expected, options.signature);
}
