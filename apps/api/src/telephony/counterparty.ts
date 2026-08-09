import { eq, schema, withOrgScope } from '@taskflow/db';
import {
  PhoneNumberSchema,
  errors,
  type KeyProvider,
  type OrgId,
  type PhoneNumber,
} from '@taskflow/contracts';
import { blindIndex, decryptString, encryptString, fieldAad } from '@taskflow/security';

/**
 * Encrypting and looking up the OTHER party's phone number (migration 0033's
 * header; PLAN.md §8.5).
 *
 * `REDACTION_PATHS` says of phone numbers: "field-encrypted at rest; logging
 * them in plaintext would defeat that entirely." This module is where that stops
 * being a comment. Every write of a counterparty number goes through
 * `sealCounterparty`, and every lookup through `counterpartyIndexFor` — a second
 * place that encrypted one would be a second place that could forget the index,
 * and a number with no index is a row Wave 3's threading can never find again.
 *
 * ## Two columns, and why neither alone would do
 *
 * `encryptString` is AES-GCM and randomized, so the same number written twice
 * produces different ciphertexts and `WHERE ciphertext = $1` matches nothing.
 * The blind index is a keyed one-way hash that supports equality and nothing
 * else. See `@taskflow/security/blind-index.ts` for why the two obvious
 * shortcuts — plaintext "just for the index", deterministic encryption — are
 * both wrong.
 *
 * ## Which key, and why it is always available
 *
 * The org's subaccount data key (`comms.subaccounts`, migration 0032), with a
 * distinct AAD per column so a ciphertext moved between rows or columns fails
 * to decrypt rather than silently returning another call's number.
 *
 * It is guaranteed to exist wherever it is needed: the Wave 1 gate refuses every
 * outbound action with `no_subaccount`, and an inbound call can only arrive on a
 * number bought through a subaccount. No subaccount means no calls, which means
 * nothing to encrypt. The invariant falls out of the gate rather than being
 * separately maintained.
 */

export interface CounterpartyCrypto {
  readonly keys: KeyProvider;
  /**
   * Blind-index key material, from `TELEPHONY_INDEX_KEY`.
   *
   * Deliberately NOT the master key or a data key: one compromise should not
   * both decrypt the column and let an attacker generate indexes to confirm
   * guesses against it.
   */
  readonly indexKey: Uint8Array;
}

export interface SealedNumber {
  readonly ciphertext: Buffer;
  readonly index: Buffer;
}

function counterpartyAad(orgId: OrgId, rowId: string): string {
  return fieldAad({
    orgId,
    table: 'comms.calls',
    column: 'counterparty_ciphertext',
    rowId,
  });
}

/**
 * Loads the org's data key.
 *
 * Separate from the sealing functions so a caller writing several rows unwraps
 * once. Unwrapping is a cheap AES operation, but it is also a database read,
 * and doing one per row inside a loop is how a bulk import becomes slow enough
 * that somebody caches the key somewhere it should not live.
 */
export async function loadOrgDataKey(orgId: OrgId, keys: KeyProvider): Promise<Uint8Array> {
  const row = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        wrapped: schema.subaccounts.dataKeyWrapped,
        masterKeyId: schema.subaccounts.dataKeyMasterId,
      })
      .from(schema.subaccounts)
      .where(eq(schema.subaccounts.orgId, orgId))
      .limit(1);
    return rows[0];
  });

  if (row === undefined) {
    /* Reachable only if a call row is being written for an org with no
       subaccount, which the gate makes impossible. Loud rather than silent: a
       fallback key here would encrypt PII under something no other row uses,
       and the failure would surface as undecryptable data much later. */
    throw errors.internal(undefined, 'No telephony key material for this organization.');
  }

  const dataKey = await keys.unwrapDataKey({
    wrapped: new Uint8Array(row.wrapped),
    masterKeyId: row.masterKeyId,
    encryptionContext: { orgId },
  });

  return dataKey.key;
}

/**
 * Encrypts a counterparty number and computes its lookup index.
 *
 * `rowId` is the call (or thread) row's own id, bound into the AAD — so the two
 * must be minted together, and the id cannot be reassigned afterwards without
 * the ciphertext becoming undecryptable. That is the intended rigidity.
 */
export function sealCounterparty(
  dataKey: Uint8Array,
  crypto: CounterpartyCrypto,
  orgId: OrgId,
  rowId: string,
  number: PhoneNumber,
): SealedNumber {
  return {
    ciphertext: Buffer.from(encryptString(dataKey, number, counterpartyAad(orgId, rowId))),
    index: counterpartyIndexFor(crypto, orgId, number),
  };
}

/**
 * The index for a lookup.
 *
 * Takes an already-parsed `PhoneNumber`, never a loose string: the index is an
 * exact equality over bytes, so `(415) 555-0100` and `+14155550100` produce
 * unrelated indexes and the lookup finds nothing while looking like it worked.
 * Parsing at the boundary is what prevents that, which is why this signature
 * refuses to normalize on the caller's behalf.
 */
export function counterpartyIndexFor(
  crypto: CounterpartyCrypto,
  orgId: OrgId,
  number: PhoneNumber,
): Buffer {
  return blindIndex(crypto.indexKey, orgId, number);
}

/**
 * Decrypts a stored counterparty number.
 *
 * Only for surfaces that are allowed to SHOW it — the call log to someone
 * holding `call:read`. Never for a log line, never for an event payload.
 */
export function openCounterparty(
  dataKey: Uint8Array,
  orgId: OrgId,
  rowId: string,
  ciphertext: Uint8Array,
): PhoneNumber {
  return PhoneNumberSchema.parse(decryptString(dataKey, ciphertext, counterpartyAad(orgId, rowId)));
}
