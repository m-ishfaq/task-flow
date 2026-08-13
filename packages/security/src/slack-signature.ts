import { createHmac } from 'node:crypto';
import { secureEqual } from './random.js';

/**
 * Slack request signature verification (ai/phase-10-automation.md §7.3,
 * https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 * ## Why this is in packages/security and not in the connector service
 *
 * Guardrail 5. This is an HMAC comparison guarding an unauthenticated write
 * path — the primitive standing between a stranger's HTTP POST and a synthetic
 * automation trigger. The rule that crypto lives in one auditable file per
 * primitive exists for exactly this shape of code.
 *
 * ## The algorithm, and the order that matters
 *
 * Slack signs `v0:<timestamp>:<raw body>` with HMAC-SHA256 keyed by the app's
 * SIGNING SECRET, hex-encoded, sent as `X-Slack-Signature: v0=<hex>`.
 *
 *   1. **The timestamp check runs BEFORE the HMAC.** A replayed body carries
 *      a perfectly valid signature — the signature is over the body AND the
 *      timestamp, so it does not go stale by itself. The five-minute freshness
 *      window is what makes an old request worthless, and skipping it turns
 *      every captured request into a valid replay forever. The docs put this
 *      step second for a reason; the order is the control.
 *   2. **The body is the EXACT bytes Slack sent.** The signature covers the
 *      raw body before any parser touches it; a route that re-serializes JSON
 *      before verifying fails every request, which is the shape of bug that
 *      gets \"fixed\" by skipping verification for a path.
 *   3. **The secret is the APP's, shared by every workspace.** It is
 *      deployment env (`SLACK_SIGNING_SECRET`), never a per-org column —
 *      which is why the telephony webhook's \"verify first, resolve the org
 *      from the verified body second\" order applies: the signature is the
 *      assertion, and `team_id` is a lookup key, never a trust input.
 */

/**
 * Rebuilds the exact string Slack signed.
 *
 * Exported for the test suite, which asserts the concatenation shape directly
 * against Slack's published worked example.
 */
export function slackSignaturePayload(timestamp: string, body: string): string {
  return `v0:${timestamp}:${body}`;
}

/**
 * Computes the `X-Slack-Signature` header value Slack would send for a
 * request.
 *
 * Exported so that tests (and slice 3's route suite) can produce a GENUINELY
 * valid signature rather than stubbing the verifier — a webhook test whose
 * signature check is mocked asserts that the handler works on trusted input,
 * which is the one case it is not defending against.
 */
export function signSlackRequest(options: {
  readonly timestamp: string;
  readonly body: string;
  readonly signingSecret: string;
}): string {
  const digest = createHmac('sha256', options.signingSecret)
    .update(Buffer.from(slackSignaturePayload(options.timestamp, options.body), 'utf8'))
    .digest('hex');
  return `v0=${digest}`;
}

/**
 * Verifies an `X-Slack-Signature` header.
 *
 * Returns a boolean rather than throwing: the caller decides the HTTP response,
 * and a thrown error inside a Fastify hook is far more likely to become a 500
 * with a stack trace than a clean 403.
 *
 * The freshness window is enforced HERE, before the HMAC, per Slack's own
 * recipe — not left to the caller, because the caller that forgets it is the
 * replay the control exists to stop.
 *
 * The comparison is constant-time (`secureEqual`), for the same reason
 * `verifyTwilioSignature` uses it: a byte-by-byte `===` on a value the caller
 * does not control would leak a valid signature for a chosen body one
 * character at a time.
 */
export function verifySlackSignature(options: {
  readonly signature: string;
  /** The `X-Slack-Request-Timestamp` header, verbatim. */
  readonly timestamp: string;
  readonly body: string;
  readonly signingSecret: string;
  /** How old a request may be before it is refused. Defaults to Slack's five minutes. */
  readonly maxAgeSeconds?: number;
  /** Overridable clock, for tests. Defaults to `Date.now()`. */
  readonly now?: number;
}): boolean {
  /* An empty signing secret would otherwise produce a perfectly valid HMAC
     under a known key — every forged request would verify. This is the failure
     mode of a misconfigured environment, not of an attacker. */
  if (options.signingSecret.length === 0) return false;
  if (options.signature.length === 0) return false;

  const match = /^(\d+)$/.exec(options.timestamp);
  if (match?.[1] === undefined) return false;

  const timestamp = Number(match[1]);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 300;
  /* The freshness check is deliberately BEFORE the HMAC: a stale request is
     refused even when its signature is perfectly valid, which is exactly what
     makes a captured request worthless outside the window. */
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxAge) return false;

  const expected = signSlackRequest({
    timestamp: options.timestamp,
    body: options.body,
    signingSecret: options.signingSecret,
  });
  return secureEqual(expected, options.signature);
}
