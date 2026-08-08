import { eq, lt, resolveOrgBySubaccountSid, schema, withOrgScope } from '@taskflow/db';
import type { KeyProvider, OrgId } from '@taskflow/contracts';
import { verifyTwilioSignature } from '@taskflow/security';
import { loadSubaccountAuthToken } from './subaccount.service.js';

/**
 * Inbound carrier webhook verification (PLAN.md §8.5; ai/phase-7-voice.md
 * §3.11).
 *
 * ⚠ Human-review surface (CLAUDE.md §2.2 — "any webhook signature
 * verification"). §6.1 named this file before it existed.
 *
 * ## No route is registered in Wave 1, deliberately
 *
 * This module is the verification and replay machinery with nothing mounted on
 * it yet. That is §3.2's build order applied to the inbound side: the gate
 * exists and refuses correctly before anything it gates can be reached, so
 * Wave 2 cannot ship a webhook route without one. `verifyInboundWebhook` is
 * fully tested; the Fastify route that calls it arrives with the first real
 * callback.
 *
 * ## Why this is not a tRPC procedure
 *
 * Every mutation elsewhere goes through `route({ permission })` — an
 * authenticated principal calling a typed procedure. A carrier webhook has no
 * principal. It is an unauthenticated, form-encoded POST from a third party
 * whose only proof of legitimacy is a signature over the exact request URL and
 * body. Forcing that into tRPC's shape would mean inventing a principal, which
 * is the one thing that must not happen here.
 *
 * ## The order of operations IS the control
 *
 * 1. Read `AccountSid` from the **unverified** body.
 * 2. Resolve which org that SID belongs to — selecting WHICH KEY to check
 *    against. This is not a trust decision and nothing is written under it.
 * 3. Decrypt that org's subaccount token and verify the signature.
 * 4. Only now may anything be validated, written, or emitted.
 *
 * Step 2 looks like trusting the payload and is not, for the same reason
 * Phase 4's `x-taskflow-org` header is safe: a client-supplied value used as a
 * LOOKUP KEY is not a client-supplied value used as an ASSERTION. Naming a
 * subaccount you do not hold the token for resolves to an org whose key then
 * refuses your signature.
 */

export type WebhookRejection =
  /** No `AccountSid`, or it maps to no org we know. */
  | 'unknown_subaccount'
  /** The org exists but has no usable credential to verify against. */
  | 'no_credential'
  /** Signature absent, malformed, or wrong. */
  | 'bad_signature'
  /** A byte-identical request already succeeded. */
  | 'replayed';

export interface WebhookAccepted {
  readonly ok: true;
  readonly orgId: OrgId;
  readonly subaccountSid: string;
  /** Recorded by `commitWebhookNonce` inside the handler's own transaction. */
  readonly signature: string;
}

export interface WebhookRejected {
  readonly ok: false;
  readonly reason: WebhookRejection;
}

export type WebhookVerdict = WebhookAccepted | WebhookRejected;

export interface WebhookRequest {
  /**
   * The absolute URL the CARRIER used, byte for byte.
   *
   * Built from `TELEPHONY_WEBHOOK_ORIGIN`, never from the incoming request's
   * own `Host` header: the signature covers this exact string, so deriving it
   * from the request would let an attacker who controls `Host` control what we
   * verify against — and the check would pass on a payload they signed with a
   * token for a URL of their choosing.
   */
  readonly url: string;
  readonly signature: string | undefined;
  /** The form-encoded body, already decoded. Not yet trusted. */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Verifies an inbound webhook. Writes nothing.
 *
 * Returns a verdict rather than throwing, because the caller's correct response
 * to every rejection here is the same terse 403 with no detail — a handler that
 * caught differentiated exceptions would be tempted to report which check
 * failed, and "unknown subaccount" versus "bad signature" tells an attacker
 * whether a SID they guessed is real.
 */
export async function verifyInboundWebhook(
  request: WebhookRequest,
  keys: KeyProvider,
): Promise<WebhookVerdict> {
  const signature = request.signature;
  if (signature === undefined || signature.length === 0) {
    /* "Reject unsigned. Non-negotiable." (PLAN.md §8.5). Checked before
       anything else so an unsigned request costs one comparison rather than a
       database read — an unauthenticated endpoint that does work before
       authenticating is a denial-of-service surface. */
    return { ok: false, reason: 'bad_signature' };
  }

  const subaccountSid = request.params['AccountSid'];
  if (subaccountSid === undefined || subaccountSid.length === 0) {
    return { ok: false, reason: 'unknown_subaccount' };
  }

  const orgId = await resolveOrgBySubaccountSid(subaccountSid);
  if (orgId === undefined) return { ok: false, reason: 'unknown_subaccount' };

  const authToken = await loadSubaccountAuthToken(orgId, keys);
  if (authToken === undefined) return { ok: false, reason: 'no_credential' };

  const valid = verifyTwilioSignature({
    url: request.url,
    signature,
    params: request.params,
    authToken,
  });
  if (!valid) return { ok: false, reason: 'bad_signature' };

  /* Replay is checked AFTER the signature, not before.
   *
   * Reversing these would let an unauthenticated caller write rows into
   * `comms.webhook_nonces` for any org whose SID they can guess — a table they
   * could then fill, and a lookup they could use to probe which signatures have
   * been seen. Nothing an unverified request says may reach storage. */
  const replayed = await isReplay(orgId, signature);
  if (replayed) return { ok: false, reason: 'replayed' };

  return { ok: true, orgId, subaccountSid, signature };
}

/**
 * Whether this exact signature has already been processed successfully.
 *
 * A read, not a claim — see `commitWebhookNonce` for why the write cannot
 * happen here.
 */
async function isReplay(orgId: OrgId, signature: string): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ signature: schema.webhookNonces.signature })
      .from(schema.webhookNonces)
      .where(eq(schema.webhookNonces.signature, signature))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Records that this signature was processed successfully.
 *
 * ## Why this takes a transaction instead of opening one
 *
 * The nonce must be written in the SAME transaction as the effect it protects.
 * Twilio legitimately RETRIES a webhook when we answer 5xx, and a retry carries
 * a byte-identical signature — so a nonce written on receipt would mark the
 * request seen, the handler would then fail, and the retry that exists to
 * recover the event would be refused as a replay. The event is lost, silently,
 * and only when something was already going wrong.
 *
 * Writing it alongside the effect makes a failed attempt roll the nonce back
 * with everything else: a retry proceeds normally, and only a replay of an
 * attempt that SUCCEEDED is refused. Same claim/write/mark-in-one-transaction
 * discipline the outbox relay uses to make the audit projection exactly-once.
 */
export async function commitWebhookNonce(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  signature: string,
): Promise<void> {
  await tx
    .insert(schema.webhookNonces)
    .values({ orgId, signature })
    .onConflictDoNothing({ target: [schema.webhookNonces.orgId, schema.webhookNonces.signature] });
}

/**
 * Deletes nonces past the retention window (PLAN.md §8.5's "5-minute window").
 *
 * Honest about what this window is: Twilio does not put a timestamp inside the
 * signed payload, so five minutes is how long a nonce is RETAINED, not an age
 * limit read off the request. A replay arriving after it would be reprocessed —
 * which is why Wave 2's call and message tables carry a UNIQUE constraint on the
 * carrier's own SID. Durable idempotency is a schema property there; this table
 * is the cheap fast path in front of it.
 */
export async function pruneWebhookNonces(orgId: OrgId, olderThanMs = 5 * 60_000): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanMs);
  await withOrgScope(orgId, async (tx) => {
    await tx.delete(schema.webhookNonces).where(lt(schema.webhookNonces.seenAt, cutoff));
  });
}
