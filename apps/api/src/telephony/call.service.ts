import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  errors,
  type OrgId,
  type PhoneNumber,
  type UserId,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { consentRequirementFor } from '@taskflow/telephony';
import { callAnnouncementPlayed, callPlaced, callStatusChanged, consentRecorded } from './events.js';
import {
  loadOrgDataKey,
  openCounterparty,
  sealCounterparty,
  type CounterpartyCrypto,
} from './counterparty.js';
import { emitRefusal, refusalMessage } from './refusal.js';
import { checkOutboundAllowed, recordSpend } from './spend-gate.js';
import { ensureSubaccount } from './subaccount.service.js';
import { loadNumber } from './number.service.js';
import { envelopeOf, orgOf, userOf, webhookContext, type TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';

/**
 * Calls — click-to-call, the call log, and the consent gate (ai/phase-7-voice.md
 * §3.5, §3.10). ⚠ Human-review surface: this file can spend money and can start
 * recording a real person.
 *
 * ## The consent decision is made HERE, before the carrier is told anything
 *
 * PLAN.md §8.5 requires a consent gate before recording begins. That is
 * implemented as three things that must all hold, and no one of them is
 * sufficient:
 *
 *   1. `consentRequirementFor` decides the rule from the destination
 *      (packages/telephony — a pure function, exhaustively tested).
 *   2. `routeToTwiml`/`outboundTwiml` emit the announcement BEFORE any verb
 *      that can capture audio, and are the only place a `record` attribute can
 *      be produced at all.
 *   3. `comms.calls`' own CHECK constraint refuses a row whose
 *      `recording_started_at` precedes a required `announcement_played_at`.
 *
 * Three layers because the first is a decision, the second is a code path, and
 * only the third is a thing the database will not let be wrong. §3.5's own
 * standard: a UI affordance a determined caller could skip is not a control.
 *
 * ## Recording is OFF unless explicitly requested
 *
 * `placeCall` takes `record: boolean` and defaults it to false at the route.
 * The alternative — recording by default with an opt-out — means the failure
 * mode of forgetting a flag is an unlawfully recorded call.
 */

export interface CallRecord {
  readonly callId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly counterparty: PhoneNumber;
  readonly status: string;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly recorded: boolean;
}

export interface PlaceCallInput {
  readonly to: PhoneNumber;
  readonly fromPhoneNumberId: string;
  readonly record: boolean;
}

export async function placeCall(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: PlaceCallInput,
): Promise<{ readonly callId: string; readonly announcementRequired: boolean }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  const from = await loadNumber(orgId, input.fromPhoneNumberId);
  if (from === undefined) throw errors.notFound('No such phone number.');

  const account = await ensureSubaccount(actor, deps);

  const estimatedCents = await deps.telephony.estimateCostCents({ kind: 'call', to: input.to });

  /* THE gate. Before the carrier hears anything about this call. */
  const decision = await checkOutboundAllowed(
    { orgId, userId, kind: 'call', to: input.to, estimatedCents },
    { defaultCapCents: deps.defaultSpendCapCents },
  );

  if (!decision.allowed) {
    await emitRefusal(actor, decision, 'call', estimatedCents);
    throw errors.quotaExceeded(refusalMessage(decision.reason));
  }

  /* Jurisdiction, from the carrier's Lookup, feeding a decision this codebase
     makes itself. A lookup failure is NOT fatal: `consentRequirementFor`
     answers with its strict default, so the call proceeds with an announcement
     rather than failing or — far worse — proceeding without one. */
  const lookup = await deps.telephony
    .lookupNumber(input.to)
    .catch(() => ({ isoCountry: undefined }) as const);

  const consent = consentRequirementFor(input.to, lookup.isoCountry);

  const callId = newId<'CallId'>();
  const dataKey = await loadOrgDataKey(orgId, deps.keys);
  const sealed = sealCounterparty(dataKey, cryptoOf(deps), orgId, callId, input.to);

  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.calls).values({
      id: callId,
      orgId,
      direction: 'outbound',
      phoneNumberId: input.fromPhoneNumberId,
      counterpartyCiphertext: sealed.ciphertext,
      counterpartyIndex: sealed.index,
      status: 'queued',
      placedBy: userId,
      consentRule: consent.rule,
      consentBasis: consent.basis,
      announcementRequired: input.record ? consent.announcementRequired : false,
    });

    await recordSpend(tx, orgId, {
      id: newId<'SpendLedgerId'>(),
      kind: 'call',
      estimatedCents,
      providerSid: undefined,
    });

    const events: DomainEvent[] = [
      createEvent(callPlaced, { callId, direction: 'outbound' as const }, envelopeOf(actor)),
    ];

    /* The consent decision gets its OWN audit entry, whether or not recording
       was requested — "we decided no announcement was needed" is exactly as
       much a governance decision as "we played one", and a compliance review
       two years from now needs both. */
    if (input.record) {
      events.push(
        createEvent(
          consentRecorded,
          {
            callId,
            rule: consent.rule,
            announcementRequired: consent.announcementRequired,
            announcementPlayed: false,
            basis: consent.basis,
          },
          envelopeOf(actor),
        ),
      );
    }

    await outboxWriter.append(tx, events);
  });

  const result = await deps.telephony.placeCall({
    subaccountSid: account.subaccountSid,
    from: from.e164,
    to: input.to,
    instructionsUrl: `${deps.webhookOrigin ?? ''}/telephony/outbound/${callId}`,
    statusCallbackUrl: `${deps.webhookOrigin ?? ''}/telephony/status/${callId}`,
  });

  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.calls)
      .set({ providerSid: result.sid, status: result.status, updatedAt: new Date() })
      .where(eq(schema.calls.id, callId));

    /* Attach the carrier's id to the ledger row so the billing callback can
       correct it. Matched on the row we just wrote, not appended. */
    await tx
      .update(schema.spendLedger)
      .set({ providerSid: result.sid })
      .where(
        and(
          eq(schema.spendLedger.orgId, orgId),
          eq(schema.spendLedger.kind, 'call'),
          eq(schema.spendLedger.estimatedCents, estimatedCents),
        ),
      );
  });

  return { callId, announcementRequired: input.record && consent.announcementRequired };
}

/**
 * Applies a carrier status callback.
 *
 * Idempotent by construction: it is matched on `provider_sid`, which is UNIQUE
 * per org, and it only ever moves a row forward. A callback replayed after the
 * 5-minute nonce window (0032) lands here again and changes nothing new — the
 * durable half of the replay defence that the nonce table is only a fast path
 * in front of.
 */
export async function applyCallStatus(
  orgId: OrgId,
  input: {
    readonly providerSid: string;
    readonly status: string;
    readonly durationSeconds?: number | undefined;
    readonly actorId?: UserId | undefined;
    readonly requestId: string;
  },
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.calls.id, status: schema.calls.status })
      .from(schema.calls)
      .where(eq(schema.calls.providerSid, input.providerSid))
      .limit(1);

    const call = rows[0];
    /* An unknown SID is not an error. The carrier legitimately reports on calls
       we did not initiate (an inbound leg that never got a row), and answering
       a webhook with a 500 makes it retry forever. */
    if (call === undefined) return;

    const now = new Date();
    await tx
      .update(schema.calls)
      .set({
        status: input.status,
        updatedAt: now,
        ...(input.status === 'in_progress' ? { answeredAt: now } : {}),
        ...(TERMINAL.has(input.status) ? { endedAt: now } : {}),
        ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      })
      .where(eq(schema.calls.id, call.id));

    await outboxWriter.append(tx, [
      createEvent(
        callStatusChanged,
        {
          callId: call.id,
          status: input.status,
          ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
        },
        webhookContext(orgId, input.requestId, input.actorId),
      ),
    ]);
  });
}

const TERMINAL = new Set(['completed', 'busy', 'no_answer', 'failed', 'canceled']);

/**
 * Records that the consent announcement actually played.
 *
 * Written from the carrier's own callback, never optimistically at the moment
 * we ASKED for it to play: the CHECK constraint on `comms.calls` compares this
 * against `recording_started_at`, and a timestamp set when we generated the
 * markup would satisfy the constraint while proving nothing about what the
 * caller heard.
 */
export async function markAnnouncementPlayed(
  orgId: OrgId,
  callId: string,
  requestId: string,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.calls)
      .set({ announcementPlayedAt: new Date() })
      .where(eq(schema.calls.id, callId));

    await outboxWriter.append(tx, [
      createEvent(callAnnouncementPlayed, { callId }, webhookContext(orgId, requestId)),
    ]);
  });
}

export async function listCalls(
  orgId: OrgId,
  deps: TelephonyDeps,
  input: { readonly limit: number },
): Promise<readonly CallRecord[]> {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        id: schema.calls.id,
        direction: schema.calls.direction,
        ciphertext: schema.calls.counterpartyCiphertext,
        status: schema.calls.status,
        startedAt: schema.calls.startedAt,
        endedAt: schema.calls.endedAt,
        durationSeconds: schema.calls.durationSeconds,
        recordingStartedAt: schema.calls.recordingStartedAt,
      })
      .from(schema.calls)
      .orderBy(desc(schema.calls.createdAt))
      .limit(input.limit),
  );

  if (rows.length === 0) return [];

  /* One key unwrap for the whole page, not one per row. */
  const dataKey = await loadOrgDataKey(orgId, deps.keys);

  return rows.map((row) => ({
    callId: row.id,
    direction: row.direction as 'inbound' | 'outbound',
    counterparty: openCounterparty(dataKey, orgId, row.id, row.ciphertext),
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    recorded: row.recordingStartedAt !== null,
  }));
}

/**
 * Records an inbound call.
 *
 * Called from the webhook AFTER signature verification. The counterparty is the
 * caller, so it is sealed exactly as an outbound destination is — an inbound
 * number is no less personal data for having arrived uninvited.
 */
export async function recordInboundCall(
  orgId: OrgId,
  deps: TelephonyDeps,
  input: {
    readonly from: PhoneNumber;
    readonly phoneNumberId: string;
    readonly providerSid: string;
    readonly requestId: string;
  },
): Promise<{ readonly callId: string; readonly announcementRequired: boolean }> {
  const consent = consentRequirementFor(input.from);
  const callId = newId<'CallId'>();
  const dataKey = await loadOrgDataKey(orgId, deps.keys);
  const sealed = sealCounterparty(dataKey, cryptoOf(deps), orgId, callId, input.from);

  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.calls).values({
      id: callId,
      orgId,
      direction: 'inbound',
      phoneNumberId: input.phoneNumberId,
      counterpartyCiphertext: sealed.ciphertext,
      counterpartyIndex: sealed.index,
      status: 'ringing',
      providerSid: input.providerSid,
      startedAt: new Date(),
      consentRule: consent.rule,
      consentBasis: consent.basis,
      announcementRequired: consent.announcementRequired,
    });

    await outboxWriter.append(tx, [
      createEvent(
        callPlaced,
        { callId, direction: 'inbound' as const },
        webhookContext(orgId, input.requestId),
      ),
    ]);
  });

  return { callId, announcementRequired: consent.announcementRequired };
}

function cryptoOf(deps: TelephonyDeps): CounterpartyCrypto {
  return { keys: deps.keys, indexKey: deps.indexKey };
}
