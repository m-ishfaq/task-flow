import { createHmac } from 'node:crypto';
import { secureEqual } from './random.js';

/**
 * Twilio webhook signature verification (PLAN.md §8.5 — "Validate
 * `X-Twilio-Signature` on every inbound request. Reject unsigned.
 * Non-negotiable."; ai/phase-7-voice.md §3.11).
 *
 * ## Why this is in packages/security and not in packages/telephony
 *
 * Guardrail 5. This is an HMAC comparison guarding an unauthenticated write
 * path — the single primitive standing between a stranger's HTTP POST and a row
 * in this database. The rule that crypto lives in one auditable file per
 * primitive exists for exactly this shape of code, and `packages/telephony`
 * cannot import `node:crypto` at all.
 *
 * ## The algorithm, and the two places it is easy to get wrong
 *
 * Twilio signs `URL + sorted(param key + param value)` with HMAC-SHA1 keyed by
 * the account auth token, base64-encoded.
 *
 *   1. **The URL must be the one the CARRIER used**, byte for byte, including
 *      scheme, port if non-default, path, and query string. Behind a proxy that
 *      terminates TLS, `request.url` is the INTERNAL http:// URL, and verifying
 *      against it fails every legitimate request — which is a fail-closed
 *      outcome, and therefore one that gets "fixed" under time pressure by
 *      skipping verification for a path. The URL is a required argument here
 *      rather than derived, so that the caller has to decide it deliberately.
 *   2. **Sorting is over the raw parameter NAMES**, ASCII, and values are
 *      appended with no separator at all — not `=`, not `&`. Concatenating with
 *      a separator produces a signature that is stable, self-consistent, and
 *      wrong for every real request.
 *
 * SHA-1 is not a choice made here. It is what Twilio signs with, and a verifier
 * that "upgraded" to SHA-256 would reject every genuine webhook while accepting
 * none — do not change it.
 */

/**
 * Rebuilds the exact string Twilio signed.
 *
 * Exported for the test suite, which asserts the concatenation shape directly:
 * a bug in this function produces a verifier that refuses everything, and
 * "refuses everything" is indistinguishable from "the auth token is wrong"
 * without being able to see what was hashed.
 */
export function twilioSignaturePayload(
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  /* `sort()` with no comparator is ASCII/UTF-16 code-unit order, which is what
     Twilio uses. Do not swap in `localeCompare` — it is locale-dependent, so
     the same request would verify on one machine and fail on another. */
  const keys = Object.keys(params).sort();

  let payload = url;
  for (const key of keys) {
    payload += key + (params[key] ?? '');
  }
  return payload;
}

/**
 * Computes the signature Twilio would send for a request.
 *
 * Exported so that tests can produce a GENUINELY valid signature rather than
 * stubbing the verifier out — a webhook test whose signature check is mocked
 * asserts that the handler works on trusted input, which is the one case it is
 * not defending against.
 *
 * This grants no capability that `verifyTwilioSignature` did not already have:
 * verification works by computing this exact value and comparing it. Naming it
 * makes that explicit instead of hiding a signer inside a verifier.
 */
export function signTwilioRequest(options: {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly authToken: string;
}): string {
  return createHmac('sha1', options.authToken)
    .update(Buffer.from(twilioSignaturePayload(options.url, options.params), 'utf8'))
    .digest('base64');
}

/**
 * Verifies an `X-Twilio-Signature` header.
 *
 * Returns a boolean rather than throwing: the caller decides the HTTP response,
 * and a thrown error inside a Fastify hook is far more likely to become a 500
 * with a stack trace than a clean 403.
 *
 * The comparison is constant-time. A byte-by-byte `===` here would let an
 * attacker with a co-located process recover a valid signature for a body of
 * their choosing one character at a time — the exact attack `secureEqual`
 * exists for.
 */
export function verifyTwilioSignature(options: {
  readonly url: string;
  readonly signature: string;
  readonly params: Readonly<Record<string, string>>;
  readonly authToken: string;
}): boolean {
  /* An empty auth token would otherwise produce a perfectly valid HMAC under a
     known key — every forged request would verify. This is the failure mode of
     a misconfigured environment, not of an attacker, which is why it is checked
     rather than assumed. */
  if (options.authToken.length === 0) return false;
  if (options.signature.length === 0) return false;

  const expected = createHmac('sha1', options.authToken)
    .update(Buffer.from(twilioSignaturePayload(options.url, options.params), 'utf8'))
    .digest('base64');

  return secureEqual(expected, options.signature);
}
