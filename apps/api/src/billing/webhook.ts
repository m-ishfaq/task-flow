import { eq, resolveOrgByStripeCustomerId, schema, withOrgScope } from '@taskflow/db';
import type { BillingWebhookEvent, OrgId, PaymentProvider } from '@taskflow/contracts';

/**
 * Inbound Stripe webhook verification (Phase 12 Wave 3 §3.5).
 *
 * ⚠ Human-review surface (CLAUDE.md §2.2 — "any webhook signature
 * verification"), identical severity to telephony's `webhook.ts`: both move
 * an org between "has access" and "does not" based on an unauthenticated
 * caller's claim, verified only by a signature.
 *
 * ## Why this is not a tRPC procedure
 *
 * The identical reasoning telephony's own `webhook.ts` gives: a webhook has
 * no principal, only a signature over the exact body Stripe sent.
 *
 * ## The order of operations, and where it differs from telephony's
 *
 * 1. Read the Stripe customer id from the payload — but UNLIKE telephony,
 *    this is not itself part of the signature check. Stripe signs with ONE
 *    account-level secret (`STRIPE_WEBHOOK_SECRET`), not a per-org one, so
 *    there is no "which org's key" step the customer id gates entry to.
 * 2. Verify the signature against that single global secret
 *    (`PaymentProvider.parseWebhookEvent`, which throws on failure — nothing
 *    is trusted before this returns).
 * 3. Resolve the org from the now-VERIFIED event's customer id.
 * 4. Only now may anything be written.
 *
 * Even though step 1's read is not a trust decision the way telephony's is,
 * it still runs before verification here, for a mechanical reason: parsing
 * IS the verification call (`parseWebhookEvent` does both at once), so
 * there is no earlier point at which an org could be known.
 */

export type WebhookRejection = 'bad_signature' | 'unknown_customer' | 'replayed';

export interface WebhookAccepted {
  readonly ok: true;
  readonly orgId: OrgId;
  readonly event: BillingWebhookEvent;
}

export interface WebhookRejected {
  readonly ok: false;
  readonly reason: WebhookRejection;
}

export type WebhookVerdict = WebhookAccepted | WebhookRejected;

export async function verifyInboundBillingWebhook(
  request: { readonly payload: string; readonly signature: string | undefined },
  payments: PaymentProvider,
  webhookSecret: string,
): Promise<WebhookVerdict> {
  if (request.signature === undefined || request.signature.length === 0) {
    return { ok: false, reason: 'bad_signature' };
  }

  let event: BillingWebhookEvent;
  try {
    event = payments.parseWebhookEvent({
      payload: request.payload,
      signature: request.signature,
      webhookSecret,
    });
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  const orgId = await resolveOrgByStripeCustomerId(event.customerId);
  if (orgId === undefined) return { ok: false, reason: 'unknown_customer' };

  /* Replay is checked AFTER the signature, not before — the identical
     "nothing an unverified request says may reach storage" reasoning
     telephony's own webhook.ts gives for the same ordering. */
  const replayed = await isReplay(orgId, event.providerEventId);
  if (replayed) return { ok: false, reason: 'replayed' };

  return { ok: true, orgId, event };
}

async function isReplay(orgId: OrgId, providerEventId: string): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ providerEventId: schema.webhookEvents.providerEventId })
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerEventId, providerEventId))
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Records that this event id was processed successfully, in the SAME
 * transaction as the effect it protects — the identical
 * claim/write/mark-in-one-transaction discipline `commitWebhookNonce` uses,
 * for the identical reason: Stripe retries an event it could not confirm was
 * handled, and a retry carries the same event id.
 */
export async function commitWebhookEvent(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  providerEventId: string,
): Promise<void> {
  await tx
    .insert(schema.webhookEvents)
    .values({ orgId, providerEventId })
    .onConflictDoNothing({
      target: [schema.webhookEvents.orgId, schema.webhookEvents.providerEventId],
    });
}
