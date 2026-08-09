import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  errors,
  type OrgId,
  type PhoneNumber,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  messageDeliveryFailed,
  messageReceived,
  messageSent,
  messageThreadCreated,
  messageThreadOptedOut,
} from './events.js';
import {
  loadOrgDataKey,
  openCounterparty,
  sealCounterparty,
  type CounterpartyCrypto,
} from './counterparty.js';
import { classifyOptOut, isSuppressed, suppress, unsuppress } from './suppression.js';
import { emitRefusal, refusalMessage } from './refusal.js';
import { checkOutboundAllowed, recordSpend } from './spend-gate.js';
import { ensureSubaccount } from './subaccount.service.js';
import { loadNumber } from './number.service.js';
import { envelopeOf, orgOf, userOf, webhookContext, type TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';

/**
 * SMS threads (ai/phase-7-voice.md §3.8, Wave 3).
 *
 * ## Sending passes TWO gates, in this order
 *
 *   1. `isSuppressed` — has this person told the org to stop? PLAN.md §8.5:
 *      "suppression list checked before every send." Checked FIRST, before the
 *      spend gate, because messaging someone who opted out is a legal problem
 *      and being over a spend cap is a billing one. If both would refuse, the
 *      one worth reporting is the opt-out.
 *   2. `checkOutboundAllowed` — the Wave 1 gate: spend cap, geo allowlist,
 *      velocity, org freeze.
 *
 * Neither is optional and neither is inlined; both live in one function called
 * from one place, so the next outbound path someone adds cannot have only one
 * of them.
 *
 * ## Threading is a blind-index lookup, not a scan
 *
 * A thread is keyed on (org, our number, THEIR number, channel), where their
 * number is the keyed one-way index from migration 0033. That unique index is
 * what makes concurrent inbound messages resolve to one conversation instead of
 * racing to create two — the symptom of which is a duplicated thread in the
 * inbox that reads as a UI bug.
 */

export interface ThreadRecord {
  readonly threadId: string;
  readonly counterparty: PhoneNumber;
  readonly lastMessageAt: Date | null;
  readonly unreadCount: number;
}

export interface MessageRecord {
  readonly messageId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  readonly status: string;
  readonly createdAt: Date;
}

export async function sendSms(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: {
    readonly to: PhoneNumber;
    readonly fromPhoneNumberId: string;
    readonly body: string;
  },
): Promise<{ readonly threadId: string; readonly messageId: string }> {
  const orgId = orgOf(actor);
  const crypto = cryptoOf(deps);

  const from = await loadNumber(orgId, input.fromPhoneNumberId);
  if (from === undefined) throw errors.notFound('No such phone number.');

  /* GATE ONE: the opt-out list, before anything else. */
  if (await isSuppressed(orgId, crypto, input.to)) {
    throw errors.forbidden('That recipient has opted out of messages from this organization.');
  }

  const account = await ensureSubaccount(actor, deps);
  const estimatedCents = await deps.telephony.estimateCostCents({ kind: 'sms', to: input.to });

  /* GATE TWO: spend, geo, velocity, org freeze. */
  const decision = await checkOutboundAllowed(
    { orgId, userId: userOf(actor), kind: 'sms', to: input.to, estimatedCents },
    { defaultCapCents: deps.defaultSpendCapCents },
  );

  if (!decision.allowed) {
    await emitRefusal(actor, decision, 'sms', estimatedCents);
    throw errors.quotaExceeded(refusalMessage(decision.reason));
  }

  const dataKey = await loadOrgDataKey(orgId, deps.keys);
  const messageId = newId<'MessageId'>();

  const result = await deps.telephony.sendSms({
    subaccountSid: account.subaccountSid,
    from: from.e164,
    to: input.to,
    body: input.body,
    statusCallbackUrl: `${deps.webhookOrigin ?? ''}/telephony/message-status/${messageId}`,
  });

  return withOrgScope(orgId, async (tx) => {
    const thread = await ensureThread(
      tx,
      orgId,
      dataKey,
      crypto,
      input.fromPhoneNumberId,
      input.to,
      envelopeOf(actor),
    );

    await tx.insert(schema.smsMessages).values({
      id: messageId,
      orgId,
      threadId: thread.threadId,
      direction: 'outbound',
      body: input.body,
      status: result.status,
      providerSid: result.sid,
      segments: result.segments,
      sentBy: userOf(actor),
    });

    await tx
      .update(schema.messageThreads)
      .set({ lastMessageAt: new Date() })
      .where(eq(schema.messageThreads.id, thread.threadId));

    /* Priced per SEGMENT by the provider — a 900-character body is six billable
       messages, and charging the ledger for one lets six times the configured
       spend through the cap. */
    await recordSpend(tx, orgId, {
      id: newId<'SpendLedgerId'>(),
      kind: 'sms',
      estimatedCents: result.costCents,
      providerSid: result.sid,
    });

    await outboxWriter.append(tx, [
      createEvent(
        messageSent,
        { threadId: thread.threadId, messageId, segments: result.segments },
        envelopeOf(actor),
      ),
    ]);

    return { threadId: thread.threadId, messageId };
  });
}

/**
 * Records an inbound SMS, and honors STOP in the same transaction.
 *
 * Called from the signature-verified webhook. The opt-out is written alongside
 * the message rather than afterwards: a STOP stored while the message recording
 * it rolls back suppresses someone with no record of why, and the reverse keeps
 * messaging someone who asked to stop.
 */
export async function receiveSms(
  orgId: OrgId,
  deps: TelephonyDeps,
  input: {
    readonly from: PhoneNumber;
    readonly phoneNumberId: string;
    readonly body: string;
    readonly providerSid: string;
    readonly requestId: string;
  },
): Promise<{ readonly threadId: string; readonly optOut: boolean }> {
  const crypto = cryptoOf(deps);
  const dataKey = await loadOrgDataKey(orgId, deps.keys);
  const intent = classifyOptOut(input.body);
  const messageId = newId<'MessageId'>();

  return withOrgScope(orgId, async (tx) => {
    const thread = await ensureThread(
      tx,
      orgId,
      dataKey,
      crypto,
      input.phoneNumberId,
      input.from,
      webhookContext(orgId, input.requestId),
    );

    await tx
      .insert(schema.smsMessages)
      .values({
        id: messageId,
        orgId,
        threadId: thread.threadId,
        direction: 'inbound',
        body: input.body,
        status: 'received',
        providerSid: input.providerSid,
      })
      /* The carrier retries inbound webhooks. Unique on (org, provider_sid), so
         a replay lands as a no-op rather than a duplicate message in the
         thread. */
      .onConflictDoNothing();

    /* Recomputed, not incremented (work/counters.ts' reasoning): an increment
       that is wrong produces a number nothing ever corrects, and a wrong badge
       looks exactly like a right one. */
    const unread = await tx
      .select({ id: schema.smsMessages.id })
      .from(schema.smsMessages)
      .where(
        and(
          eq(schema.smsMessages.threadId, thread.threadId),
          eq(schema.smsMessages.direction, 'inbound'),
        ),
      );

    await tx
      .update(schema.messageThreads)
      .set({ lastMessageAt: new Date(), unreadCount: unread.length })
      .where(eq(schema.messageThreads.id, thread.threadId));

    const events: DomainEvent[] = [
      createEvent(
        messageReceived,
        { threadId: thread.threadId, messageId },
        webhookContext(orgId, input.requestId),
      ),
    ];

    if (intent === 'stop') {
      await suppress(tx, orgId, dataKey, crypto, input.from, 'stop_keyword');
      events.push(
        createEvent(
          messageThreadOptedOut,
          { threadId: thread.threadId, reason: 'stop_keyword' as const, revoked: false },
          webhookContext(orgId, input.requestId),
        ),
      );
    } else if (intent === 'start') {
      await unsuppress(tx, orgId, crypto, input.from);
      events.push(
        createEvent(
          messageThreadOptedOut,
          { threadId: thread.threadId, reason: 'stop_keyword' as const, revoked: true },
          webhookContext(orgId, input.requestId),
        ),
      );
    }

    await outboxWriter.append(tx, events);

    return { threadId: thread.threadId, optOut: intent === 'stop' };
  });
}

/** Applies a delivery status callback. Idempotent on the carrier's own sid. */
export async function applyMessageStatus(
  orgId: OrgId,
  input: {
    readonly providerSid: string;
    readonly status: string;
    readonly errorCode: string | undefined;
    readonly requestId: string;
  },
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.smsMessages.id })
      .from(schema.smsMessages)
      .where(eq(schema.smsMessages.providerSid, input.providerSid))
      .limit(1);

    const message = rows[0];
    /* An unknown sid is not an error — the carrier legitimately reports on
       messages we have no row for, and a 500 makes it retry forever. */
    if (message === undefined) return;

    await tx
      .update(schema.smsMessages)
      .set({
        status: input.status,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.status === 'delivered' ? { deliveredAt: new Date() } : {}),
      })
      .where(eq(schema.smsMessages.id, message.id));

    if (input.status === 'undelivered' || input.status === 'failed') {
      await outboxWriter.append(tx, [
        createEvent(
          messageDeliveryFailed,
          {
            messageId: message.id,
            status: input.status,
            ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          },
          webhookContext(orgId, input.requestId),
        ),
      ]);
    }
  });
}

export async function listThreads(
  orgId: OrgId,
  deps: TelephonyDeps,
  input: { readonly limit: number },
): Promise<readonly ThreadRecord[]> {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        id: schema.messageThreads.id,
        ciphertext: schema.messageThreads.counterpartyCiphertext,
        lastMessageAt: schema.messageThreads.lastMessageAt,
        unreadCount: schema.messageThreads.unreadCount,
      })
      .from(schema.messageThreads)
      .orderBy(desc(schema.messageThreads.lastMessageAt))
      .limit(input.limit),
  );

  if (rows.length === 0) return [];

  /* One key unwrap for the page, not one per row. */
  const dataKey = await loadOrgDataKey(orgId, deps.keys);

  return rows.map((row) => ({
    threadId: row.id,
    counterparty: openCounterparty(dataKey, orgId, row.id, row.ciphertext),
    lastMessageAt: row.lastMessageAt,
    unreadCount: row.unreadCount,
  }));
}

export async function listMessages(
  orgId: OrgId,
  input: { readonly threadId: string; readonly limit: number },
): Promise<readonly MessageRecord[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.smsMessages.id,
        direction: schema.smsMessages.direction,
        body: schema.smsMessages.body,
        status: schema.smsMessages.status,
        createdAt: schema.smsMessages.createdAt,
      })
      .from(schema.smsMessages)
      .where(eq(schema.smsMessages.threadId, input.threadId))
      .orderBy(desc(schema.smsMessages.createdAt))
      .limit(input.limit);

    return rows.map((row) => ({
      messageId: row.id,
      direction: row.direction as 'inbound' | 'outbound',
      body: row.body,
      status: row.status,
      createdAt: row.createdAt,
    }));
  });
}

/**
 * Finds or creates the thread for a conversation.
 *
 * Takes the caller's own transaction rather than opening one — `sendSms` and
 * `receiveSms` each call this from inside their own `withOrgScope`, so a
 * newly created thread is written in the SAME transaction as the message
 * that started it. This function appends `message_thread.created` itself,
 * exactly when it inserts a new row, rather than reporting `created` back
 * for the caller to decide whether to emit — the event and the mutation that
 * causes it stay next to each other instead of split across two functions
 * that both have to independently remember the same boolean.
 *
 * `onConflictDoNothing` then re-select, rather than select-then-insert: two
 * inbound messages arriving together would both see no thread and both insert,
 * and the unique index on (org, our number, their index, channel) is what
 * adjudicates. The loser reads the winner's row.
 */
async function ensureThread(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  dataKey: Uint8Array,
  crypto: CounterpartyCrypto,
  phoneNumberId: string,
  counterparty: PhoneNumber,
  eventContext: Parameters<typeof createEvent>[2],
): Promise<{ readonly threadId: string }> {
  const threadId = newId<'MessageThreadId'>();
  const sealed = sealCounterparty(dataKey, crypto, orgId, threadId, counterparty);

  const inserted = await tx
    .insert(schema.messageThreads)
    .values({
      id: threadId,
      orgId,
      channel: 'sms',
      phoneNumberId,
      counterpartyCiphertext: sealed.ciphertext,
      counterpartyIndex: sealed.index,
    })
    .onConflictDoNothing()
    .returning({ id: schema.messageThreads.id });

  const createdId = inserted[0]?.id;
  if (createdId !== undefined) {
    await outboxWriter.append(tx, [
      createEvent(messageThreadCreated, { threadId: createdId }, eventContext),
    ]);
    return { threadId: createdId };
  }

  const existing = await tx
    .select({ id: schema.messageThreads.id })
    .from(schema.messageThreads)
    .where(
      and(
        eq(schema.messageThreads.phoneNumberId, phoneNumberId),
        eq(schema.messageThreads.counterpartyIndex, sealed.index),
        eq(schema.messageThreads.channel, 'sms'),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (row === undefined) {
    throw errors.internal(undefined, 'Message thread could not be resolved after a conflict.');
  }
  return { threadId: row.id };
}

function cryptoOf(deps: TelephonyDeps): CounterpartyCrypto {
  return { keys: deps.keys, indexKey: deps.indexKey };
}
