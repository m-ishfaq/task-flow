import { withOpsEventScope } from './client.js';
import { operationalEvents } from './schema/platform.js';

/**
 * The operations dashboard's write side (migration 0061). Records one row
 * per system action outcome — a mail send, a billing webhook, a sweep tick —
 * so a solo operator has a real answer to "did that work" without SSHing in
 * and grepping container logs.
 *
 * Lives here rather than in `apps/api` because `withOpsEventScope` is a
 * `packages/db`-only connection (the role has no reason to be reachable
 * outside the data layer), the same shape as `resolveOrgByStripeCustomerId`.
 *
 * `target`/`detail` are the SAME redaction discipline the mail queue's
 * existing `onFailure` callback already applies to its own log line
 * (`packages/mail/src/queue.ts`'s own comment): an email address or a
 * Stripe event id is fine, a verification link or a card number is not —
 * every caller of this function is a human-review surface for that reason
 * alone, even though the table itself carries no security control.
 */
export interface OperationalEventInput {
  readonly kind: 'mail' | 'billing_webhook' | 'billing_sweep' | 'push';
  readonly outcome: 'success' | 'failure';
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Never throws into the caller — every call site of this function sits on a
 * path (mail delivery, a webhook response, a sweep tick) that must not fail
 * BECAUSE the observability write failed. A missing ops-events connection
 * degrades to "no dashboard row", not "the mail queue crashes" or "the
 * webhook 500s" — logged to the caller's own logger instead, so the failure
 * is still visible somewhere.
 */
export async function recordOperationalEvent(
  input: OperationalEventInput,
  onWriteFailure?: (error: unknown) => void,
): Promise<void> {
  try {
    await withOpsEventScope(async (tx) => {
      await tx.insert(operationalEvents).values({
        kind: input.kind,
        outcome: input.outcome,
        target: input.target ?? null,
        detail: input.detail ?? null,
      });
    });
  } catch (error) {
    onWriteFailure?.(error);
  }
}
