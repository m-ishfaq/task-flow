import { and, eq, schema, type withOrgScope } from '@taskflow/db';
import type { AttachmentId } from '@taskflow/contracts';

/**
 * The attachment status transition that carries no event of its own.
 *
 * ## Why this is not in attachment.service.ts
 *
 * Guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and this one deliberately does not. `pending -> scanning` is an
 * internal claim, not something that happened to a user's data: it says "this
 * confirm is in progress", and the event worth recording is the VERDICT that
 * follows a moment later. Emitting one here would put two entries in the audit
 * log for one upload, the first of which is never interesting.
 *
 * Same reasoning as `rebalance.ts` and `counters.ts` — the rule's scope means
 * repositories mutate by design, and the event belongs to the operation the
 * user performed.
 *
 * ## What it is actually for
 *
 * It is a claim, and its return value is the concurrency control. Two confirms
 * racing on one attachment — a double-clicked button, a client retry — would
 * otherwise both read `pending`, both scan, and both write a verdict. The
 * status is part of the WHERE clause, so exactly one of them updates a row and
 * the loser is told the upload was already confirmed.
 */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Moves a pending attachment to `scanning`, returning whether this caller won.
 *
 * A conditional UPDATE rather than SELECT-then-UPDATE: the check and the write
 * are one statement, so there is no window where both racers have read
 * `pending` and neither has written yet.
 */
export async function claimForScanning(tx: Tx, attachmentId: AttachmentId): Promise<boolean> {
  const claimed = await tx
    .update(schema.attachments)
    .set({ status: 'scanning', updatedAt: new Date() })
    /* `status = 'pending'` is the load-bearing half. Without it this is an
       unconditional write that always reports success, both racers proceed to
       scan, and the second one's verdict overwrites the first — including
       overwriting `infected` with `clean` if the object was deleted in
       between. */
    .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.status, 'pending')))
    .returning({ id: schema.attachments.id });

  return claimed.length > 0;
}
