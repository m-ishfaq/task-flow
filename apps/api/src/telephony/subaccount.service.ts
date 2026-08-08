import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  errors,
  type KeyProvider,
  type OrgId,
  type SubaccountStatus,
  type TelephonyProvider,
} from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { decryptString, encryptString, fieldAad } from '@taskflow/security';
import { subaccountProvisioned, subaccountStatusChanged } from './events.js';
import type { TelephonyActor } from './shared.js';
import { envelopeOf, orgOf } from './shared.js';

/**
 * Per-org carrier subaccount provisioning (ai/phase-7-voice.md §3.1).
 *
 * PLAN.md §8.5: "Twilio subaccount per org — a leaked credential's blast radius
 * is one tenant." That is the same reasoning RLS applies to data at rest,
 * extended to a THIRD PARTY's credential: a leaked key for one org's subaccount
 * can place calls on that org's balance and nothing else's.
 *
 * ## This is `KeyProvider`'s first real consumer
 *
 * Envelope encryption has existed since Phase 0B with a software implementation
 * and no caller — `providers/index.ts` says interfaces wait for a real consumer
 * "because an interface designed without one is a guess." This is it: a
 * per-org data key wraps the subaccount's auth token, and the master key wraps
 * the data key. Destroying an org's data key makes its carrier credential
 * unrecoverable, which is what GDPR erasure looks like at scale.
 *
 * ## What the stored token is, and is not
 *
 * It is NOT how outbound calls authenticate. Those use the subaccount SID with
 * the MASTER auth token, which Twilio accepts for its children — so the
 * application can spend without ever decrypting this. It is needed for exactly
 * one thing: verifying the signature on webhooks Twilio signed with this
 * subaccount's own token, which nothing else can check. A verification key that
 * happens to also be a credential, which is why it is encrypted rather than
 * merely access-controlled.
 */

export interface SubaccountDeps {
  readonly telephony: TelephonyProvider;
  readonly keys: KeyProvider;
}

export interface SubaccountRecord {
  readonly orgId: OrgId;
  readonly subaccountSid: string;
  readonly provider: string;
  readonly status: SubaccountStatus;
}

/**
 * The AAD binding the ciphertext to the row it belongs in.
 *
 * Without it, a ciphertext copied from one org's row into another's would
 * decrypt cleanly under the target org's key if the two ever shared one — and
 * more practically, a restore that shuffled rows would go unnoticed. With it,
 * decryption of a moved value FAILS rather than silently returning the wrong
 * org's credential.
 */
function tokenAad(orgId: OrgId): string {
  /* `rowId` is the org id because org_id IS this table's primary key — one
     subaccount per org. If a second row per org ever exists, this must become
     that row's id or every ciphertext binds to the same AAD and the protection
     against a value moved between rows disappears. */
  return fieldAad({
    orgId,
    table: 'comms.subaccounts',
    column: 'auth_token_ciphertext',
    rowId: orgId,
  });
}

/**
 * Provisions this org's subaccount, or returns the existing one.
 *
 * Idempotent by the org's PRIMARY KEY on `comms.subaccounts`, not by a
 * read-then-write: two concurrent first calls would both see no row and both
 * create a subaccount AT TWILIO, and the loser's would be an orphaned account
 * this system has no record of and still pays for. The insert is conditional
 * (`ON CONFLICT DO NOTHING`), and the loser releases what it created.
 */
export async function ensureSubaccount(
  actor: TelephonyActor,
  deps: SubaccountDeps,
): Promise<SubaccountRecord> {
  const orgId = orgOf(actor);

  const existing = await loadSubaccount(orgId);
  if (existing !== undefined) return existing;

  /* The carrier call happens OUTSIDE the transaction on purpose. Holding a
     Postgres transaction open across a third-party network round trip means one
     slow carrier response pins a connection from a pool of ten, and a carrier
     outage takes the database down with it. */
  const created = await deps.telephony.createSubaccount({
    friendlyName: `taskflow-org-${orgId}`,
  });

  const dataKey = await deps.keys.generateDataKey({ orgId });
  const ciphertext = Buffer.from(
    encryptString(dataKey.plaintext.key, created.authToken, tokenAad(orgId)),
  );

  const inserted = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .insert(schema.subaccounts)
      .values({
        orgId,
        provider: 'twilio',
        subaccountSid: created.sid,
        authTokenCiphertext: ciphertext,
        dataKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
        dataKeyMasterId: dataKey.wrapped.masterKeyId,
        status: 'active',
      })
      .onConflictDoNothing({ target: schema.subaccounts.orgId })
      .returning({ sid: schema.subaccounts.subaccountSid });

    if (rows.length === 0) return undefined;

    /* The pre-tenant lookup row (§3.11, migration 0032). Written in the SAME
       transaction as the subaccount itself — a subaccount whose SID resolves to
       no org is a webhook that can never be verified, and the two rows going in
       separately means a crash between them produces exactly that. */
    await tx
      .insert(schema.subaccountOrgs)
      .values({ subaccountSid: created.sid, orgId })
      .onConflictDoNothing({ target: schema.subaccountOrgs.subaccountSid });

    await outboxWriter.append(tx, [
      createEvent(
        subaccountProvisioned,
        { subaccountSid: created.sid, provider: 'twilio' },
        envelopeOf(actor),
      ),
    ]);

    return rows[0];
  });

  if (inserted === undefined) {
    /* Lost the race. Release what we just created at the carrier rather than
       leaving a subaccount nothing references — an orphan still bills, and
       nothing in this system would ever mention it again. */
    await deps.telephony
      .setSubaccountStatus(created.sid, 'closed')
      .catch(() => undefined /* Best effort; the winner's row is what matters. */);

    const winner = await loadSubaccount(orgId);
    if (winner === undefined) {
      throw errors.internal(undefined, 'Subaccount provisioning raced and left no record.');
    }
    return winner;
  }

  return { orgId, subaccountSid: created.sid, provider: 'twilio', status: 'active' };
}

/** Reads this org's subaccount, without its credential. */
export async function loadSubaccount(orgId: OrgId): Promise<SubaccountRecord | undefined> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        subaccountSid: schema.subaccounts.subaccountSid,
        provider: schema.subaccounts.provider,
        status: schema.subaccounts.status,
      })
      .from(schema.subaccounts)
      .limit(1);

    const row = rows[0];
    if (row === undefined) return undefined;

    return {
      orgId,
      subaccountSid: row.subaccountSid,
      provider: row.provider,
      status: row.status as SubaccountStatus,
    };
  });
}

/**
 * Decrypts this org's subaccount auth token.
 *
 * The ONLY legitimate caller is webhook signature verification. Not exported
 * through a route, not returned from a service method a router can reach, and
 * never placed in an event payload — an outbox event is persisted and projected
 * into the audit log, where `REDACTION_PATHS` never runs.
 */
export async function loadSubaccountAuthToken(
  orgId: OrgId,
  keys: KeyProvider,
): Promise<string | undefined> {
  const row = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        ciphertext: schema.subaccounts.authTokenCiphertext,
        wrapped: schema.subaccounts.dataKeyWrapped,
        masterKeyId: schema.subaccounts.dataKeyMasterId,
      })
      .from(schema.subaccounts)
      .limit(1);
    return rows[0];
  });

  if (row === undefined) return undefined;

  const dataKey = await keys.unwrapDataKey({
    wrapped: new Uint8Array(row.wrapped),
    masterKeyId: row.masterKeyId,
    encryptionContext: { orgId },
  });

  return decryptString(dataKey.key, new Uint8Array(row.ciphertext), tokenAad(orgId));
}

/**
 * Freezes or unfreezes an org's carrier subaccount.
 *
 * Two halves, and the second is the one that is easy to skip. Refusing outbound
 * actions in `checkOutboundAllowed` stops THIS APPLICATION from spending; it
 * does nothing about a leaked subaccount credential used directly against
 * Twilio, which answers to whoever holds the token. `ai/phase-12-admin.md` §9
 * names that gap explicitly. So the carrier is updated too — and when the
 * carrier call fails, the local record is still written and the event says
 * `carrierUpdated: false`, because a half-applied freeze that is RECORDED as
 * half-applied is far better than one that silently reports success.
 */
export async function setSubaccountStatus(
  actor: TelephonyActor,
  deps: SubaccountDeps,
  status: SubaccountStatus,
): Promise<{ readonly carrierUpdated: boolean }> {
  const orgId = orgOf(actor);
  const record = await loadSubaccount(orgId);
  if (record === undefined) throw errors.notFound('No carrier subaccount for this organization.');

  let carrierUpdated = true;
  try {
    await deps.telephony.setSubaccountStatus(record.subaccountSid, status);
  } catch {
    carrierUpdated = false;
  }

  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.subaccounts)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.subaccounts.orgId, orgId));

    await outboxWriter.append(tx, [
      createEvent(
        subaccountStatusChanged,
        { subaccountSid: record.subaccountSid, status, carrierUpdated },
        envelopeOf(actor),
      ),
    ]);
  });

  return { carrierUpdated };
}
