import { createHmac } from 'node:crypto';
import { secureEqual } from './random.js';

/**
 * GitHub webhook signature verification (ai/phase-10-automation.md §7.3,
 * https://docs.github.com/en/webhooks-and-events/webhooks/securing-your-webhooks).
 *
 * ## Why this is in packages/security and not in the connector service
 *
 * Guardrail 5, stated once: this HMAC comparison guards an unauthenticated
 * write path, and the crypto lives in one auditable file per primitive.
 *
 * ## The algorithm, and what it does NOT have
 *
 * GitHub signs the RAW BODY with HMAC-SHA256 keyed by the per-webhook secret,
 * sent as `X-Hub-Signature-256: sha256=<hex>`.
 *
 *   1. **No timestamp, and therefore no freshness check.** Unlike Slack's
 *      scheme, GitHub puts no timestamp in the signature — a captured request
 *      can be replayed forever. What GitHub DOES provide is `X-GitHub-Delivery`,
 *      a unique delivery id per attempt; the caller dedupes on it (Twilio's
 *      webhook_nonces recipe, written on SUCCESS), and this primitive is
 *      deliberately silent on the subject. A dedupe key is a route concern,
 *      not a signature concern.
 *   2. **The secret is PER-ORG, never deployment-wide.** Each org creates its
 *      own repo webhook with its own secret, stored on its own integration row
 *      (D4). That forces the resolution order the telephony webhook makes: the
 *      org is resolved from `repository.full_name` in the UNVERIFIED body,
 *      the secret loaded, and only then is the signature checked — which is
 *      why the lookup role in migration 0056 may read the verify columns.
 *   3. **The body is the EXACT bytes GitHub sent.** A route that re-serializes
 *      JSON before verifying fails every request. `X-GitHub-Delivery` and
 *      `X-Hub-Signature-256` are the only headers the algorithm touches.
 *
 * The prefix is matched strictly (`sha256=`, lowercase): GitHub is the only
 * sender, and GitHub always sends lowercase.
 */

/**
 * Computes the `X-Hub-Signature-256` header value GitHub would send for a
 * body under a given secret.
 *
 * Exported so that tests (and slice 3's route suite) can produce a GENUINELY
 * valid signature rather than stubbing the verifier out.
 */
export function signGitHubRequest(options: {
  readonly secret: string;
  readonly body: string;
}): string {
  const digest = createHmac('sha256', options.secret)
    .update(Buffer.from(options.body, 'utf8'))
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verifies an `X-Hub-Signature-256` header.
 *
 * Returns a boolean rather than throwing, for the same reason
 * `verifySlackSignature` does: the caller decides the HTTP response, and a
 * thrown error inside a hook becomes a 500 rather than a clean 403.
 *
 * The comparison is constant-time (`secureEqual`) — the same argument as
 * every other verifier in this package.
 */
export function verifyGitHubSignature(options: {
  readonly signature: string;
  readonly body: string;
  readonly secret: string;
}): boolean {
  /* An empty secret would otherwise produce a perfectly valid HMAC under a
     known key — every forged request would verify. This is the failure mode of
     a misconfigured environment, not of an attacker. */
  if (options.secret.length === 0) return false;
  if (options.signature.length === 0) return false;
  /* Strict prefix, fail-closed: the sender is always GitHub, and GitHub always
     sends the lowercase prefix. Accepting both spellings would be accepting a
     second framing of the same check for no sender that uses it. */
  if (!options.signature.startsWith('sha256=')) return false;

  const expected = signGitHubRequest({ secret: options.secret, body: options.body });
  return secureEqual(expected, options.signature);
}
