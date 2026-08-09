import { and, eq, isNull, schema, withOrgScope } from '@taskflow/db';
import type { OrgId, PhoneNumber } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import { counterpartyIndexFor, sealCounterparty, type CounterpartyCrypto } from './counterparty.js';

/**
 * The opt-out suppression list (PLAN.md §8.5 — "STOP/UNSUBSCRIBE honored
 * automatically and permanently at org level; suppression list checked before
 * every send").
 *
 * ## Why this is a separate module and not two queries inside the send path
 *
 * The same reasoning `checkOutboundAllowed` gets its own file for. There is
 * exactly one function that answers "may this org message this number", and
 * every send routes through it. A suppression check inlined at a call site is
 * one that the NEXT send path — a Phase 10 automation action, a bulk notify —
 * quietly does not have, and the failure is invisible until a regulator or an
 * angry recipient surfaces it.
 *
 * ## The keywords are a closed table, and matching is deliberately generous
 *
 * `STOP` is what the carriers standardise on, but people type `stop.`,
 * `Stop please`, `UNSUBSCRIBE`. Matching only an exact uppercase `STOP` is
 * technically defensible and practically an opt-out that does not work.
 *
 * Generosity has a bound in one direction only: a false POSITIVE stops messages
 * to someone who did not quite mean it, which they can undo with START. A false
 * NEGATIVE is continuing to message someone who told you to stop, which is the
 * thing with legal consequences. When in doubt, suppress.
 */

/** Recognised opt-out keywords. Carrier-standard set. */
const STOP_KEYWORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt-out',
]);

/** Recognised opt-back-in keywords. */
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'optin', 'opt-in']);

export type OptOutIntent = 'stop' | 'start' | 'none';

/**
 * Classifies an inbound message body.
 *
 * Normalised aggressively — case folded, punctuation stripped, whitespace
 * collapsed — and then matched against the whole message, not a substring. A
 * substring match would suppress someone who wrote "please don't stop sending
 * these", which is the opposite of what they asked for.
 */
export function classifyOptOut(body: string): OptOutIntent {
  const normalized = body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');

  if (normalized.length === 0) return 'none';

  /* A single word is the carrier convention and the overwhelmingly common
     case. Two or three words are accepted too ("stop please", "please stop")
     because people are polite; beyond that it is prose that happens to contain
     the word. */
  const words = normalized.split(' ');
  if (words.length > 3) return 'none';

  for (const word of words) {
    if (STOP_KEYWORDS.has(word)) return 'stop';
  }
  for (const word of words) {
    if (START_KEYWORDS.has(word)) return 'start';
  }
  return 'none';
}

/**
 * Whether this org is currently forbidden from messaging this number.
 *
 * Checked before EVERY send. Reads by blind index, so the number is never in
 * plaintext in the query or the column.
 */
export async function isSuppressed(
  orgId: OrgId,
  crypto: CounterpartyCrypto,
  number: PhoneNumber,
): Promise<boolean> {
  const index = counterpartyIndexFor(crypto, orgId, number);

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.suppressions.id })
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.counterpartyIndex, index),
          /* Live suppressions only. A revoked row is a historical record that
             someone once opted out, kept deliberately — it must not keep
             blocking them after they opted back in. */
          isNull(schema.suppressions.revokedAt),
        ),
      )
      .limit(1);

    return rows.length > 0;
  });
}

/**
 * Records an opt-out.
 *
 * Takes a transaction, because it is written in the SAME transaction as the
 * inbound message that requested it. A STOP that is stored while the message
 * recording it rolls back would suppress someone with no record of why; the
 * reverse — the message stored and the suppression lost — would keep messaging
 * someone who asked to stop. Both are avoided by committing together.
 */
export async function suppress(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  dataKey: Uint8Array,
  crypto: CounterpartyCrypto,
  number: PhoneNumber,
  reason: 'stop_keyword' | 'manual' | 'carrier_report',
): Promise<void> {
  const id = newId<'SuppressionId'>();
  const sealed = sealCounterparty(dataKey, crypto, orgId, id, number);

  await tx
    .insert(schema.suppressions)
    .values({
      id,
      orgId,
      counterpartyCiphertext: sealed.ciphertext,
      counterpartyIndex: sealed.index,
      reason,
    })
    /* Already suppressed is success, not a conflict. Someone texting STOP twice
       is a person making sure, and answering the second one with an error would
       turn a working opt-out into a 500. */
    .onConflictDoNothing();
}

/**
 * Records an opt-back-in.
 *
 * Sets `revoked_at` rather than deleting. The row is the evidence that an
 * opt-out was once honored, and a compliance question two years from now is
 * "did you stop when they asked" — which a deleted row cannot answer.
 */
export async function unsuppress(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  crypto: CounterpartyCrypto,
  number: PhoneNumber,
): Promise<void> {
  await tx
    .update(schema.suppressions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.suppressions.counterpartyIndex, counterpartyIndexFor(crypto, orgId, number)),
        isNull(schema.suppressions.revokedAt),
      ),
    );
}
