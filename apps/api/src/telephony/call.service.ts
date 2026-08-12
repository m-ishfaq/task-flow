import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  errors,
  type OrgId,
  type OutboundKind,
  type PhoneNumber,
  type UserId,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { consentRequirementFor } from '@taskflow/telephony';
import {
  callAnnouncementPlayed,
  callPlaced,
  callStatusChanged,
  consentRecorded,
} from './events.js';
import {
  loadOrgDataKey,
  openCounterparty,
  sealCounterparty,
  type CounterpartyCrypto,
} from './counterparty.js';
import { rethrowCarrierRefusal } from './carrier-error.js';
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

/**
 * Why this call is being placed — attribution for the ledger and the gate.
 *
 * The automation path (Phase 10 Wave 4 §5.5) is NOT a different gate: it is
 * the same `checkOutboundAllowed` with the same geo table, org freeze,
 * subaccount check, rolling cap and velocity limiter. What changes is the
 * KIND the gate sees and the ledger records — `automation_call` instead of
 * `call` — so the sub-budget can sum unattended spend and a runaway rule
 * cannot consume the allowance a human needs for a real customer call.
 */
export interface PlaceCallOptions {
  readonly initiatedBy?: 'automation';
}

export async function placeCall(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: PlaceCallInput,
  options: PlaceCallOptions = {},
): Promise<{ readonly callId: string; readonly announcementRequired: boolean }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  const from = await loadNumber(orgId, input.fromPhoneNumberId);
  if (from === undefined) throw errors.notFound('No such phone number.');

  const account = await ensureSubaccount(actor, deps);

  /* Priced with the BASE kind, never the automation one: a call costs what a
     call costs, and the provider's rate card is keyed on what the action IS,
     not on who asked for it. The attributed kind enters at the gate below. */
  const estimatedCents = await deps.telephony.estimateCostCents({ kind: 'call', to: input.to });

  /* THE gate. Before the carrier hears anything about this call — and the
     automation path passes it identically, under its attributed kind, so the
     sub-budget (§5.5) and the velocity table see an unattended caller as its
     own actor rather than silently borrowing the human 'call' bucket. */
  const kind: OutboundKind =
    options.initiatedBy === 'automation' ? 'automation_call' : 'call';
  const decision = await checkOutboundAllowed(
    { orgId, userId, kind, to: input.to, estimatedCents },
    { defaultCapCents: deps.defaultSpendCapCents },
  );

  if (!decision.allowed) {
    await emitRefusal(actor, decision, kind, estimatedCents);
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
  /* Minted here rather than inline at the insert because the second transaction
     below must name THIS ledger row to attach the carrier's SID to it. */
  const spendId = newId<'SpendLedgerId'>();
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
      /* Two separate facts (migration 0038). `recordRequested` is what the
         caller asked for; `announcementRequired` is what the consent rule
         demands given that request. Collapsing them lost the first entirely in
         one-party jurisdictions, where the second is false either way. */
      recordRequested: input.record,
      announcementRequired: input.record ? consent.announcementRequired : false,
    });

    await recordSpend(tx, orgId, {
      id: spendId,
      kind,
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

  /* Same translation `sendSms` applies: an unreachable destination is a refusal
     the caller can act on, not a fault.

     Unlike `sendSms`, this runs AFTER the row and its ledger entry have
     committed (§3.4 — the charge lands before the carrier is told anything, so
     a crash mid-flight can never leave a placed call unbilled). That ordering
     is right, and it has a consequence that must be paid for here: a refusal
     leaves a `queued` call that never happened, holding its estimate against
     the org's 30-day cap with no provider SID for reconciliation to correct it
     by. Nothing else would ever release it — status callbacks only arrive for
     calls the carrier accepted.

     So the refusal path compensates before rethrowing. */
  const result = await deps.telephony
    .placeCall({
      subaccountSid: account.subaccountSid,
      from: from.e164,
      to: input.to,
      instructionsUrl: `${deps.webhookOrigin ?? ''}/telephony/outbound/${callId}`,
      statusCallbackUrl: `${deps.webhookOrigin ?? ''}/telephony/status/${callId}`,
    })
    .catch(async (error: unknown) => {
      await releaseUnplacedCall(actor, callId, spendId);
      return rethrowCarrierRefusal(error);
    });

  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.calls)
      .set({ providerSid: result.sid, status: result.status, updatedAt: new Date() })
      .where(eq(schema.calls.id, callId));

    /* Attach the carrier's id to the ledger row so the billing callback can
       correct it. Matched on the row's own PRIMARY KEY, never on its shape:
       `(org_id, kind, estimated_cents)` describes every previous call priced
       the same, so that UPDATE stamped one SID onto the org's whole call
       history and was refused by `spend_ledger_provider_sid_key` — after the
       carrier had already been told to dial. The call happened, the request
       500'd, and the ledger row stayed unattached, so reconciliation could
       never correct the estimate either. */
    await tx
      .update(schema.spendLedger)
      .set({ providerSid: result.sid })
      .where(and(eq(schema.spendLedger.orgId, orgId), eq(schema.spendLedger.id, spendId)));
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
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: input.durationSeconds }),
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
 * Releases the money held for a call the carrier refused to place.
 *
 * ## Why `actual_cents = 0` and not a deleted row
 *
 * The cap is summed with `COALESCE(actual, estimated)` (`sumWithFallback`),
 * precisely so an unbilled in-flight action still counts — that is the window
 * an attacker exploits by going faster than reconciliation. Writing a real,
 * known-final `0` is therefore the only way to release the hold without
 * weakening that rule: it says "this one is settled, and it settled at
 * nothing", which is the truth for a call the carrier never accepted.
 *
 * Deleting the row would also release it, and would destroy the record that an
 * attempt was made. The ledger is the spend record; an attempt that failed is
 * exactly the kind of thing a bill dispute needs to see.
 *
 * ## Best-effort, and it rethrows nothing
 *
 * The caller is already on its way to throwing the carrier's refusal, which is
 * the error the user needs. A failure to compensate must not replace it — the
 * worst case is one estimate held for 30 days, against a cap that is a
 * safety limit rather than an invoice.
 */
async function releaseUnplacedCall(
  actor: TelephonyActor,
  callId: string,
  spendId: string,
): Promise<void> {
  const orgId = orgOf(actor);

  try {
    await withOrgScope(orgId, async (tx) => {
      await tx
        .update(schema.calls)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(schema.calls.id, callId));

      await tx
        .update(schema.spendLedger)
        .set({ actualCents: 0 })
        .where(and(eq(schema.spendLedger.orgId, orgId), eq(schema.spendLedger.id, spendId)));

      /* Guardrail 6: the status transition is a state change like any other,
         and the call log would otherwise show `queued` forever with nothing
         explaining why. */
      await outboxWriter.append(tx, [
        createEvent(callStatusChanged, { callId, status: 'failed' }, envelopeOf(actor)),
      ]);
    });
  } catch {
    /* Swallowed deliberately — see the note above. */
  }
}

/** What `/telephony/outbound/:callId` needs to build the call's TwiML. */
export interface OutboundCallInstructions {
  readonly to: PhoneNumber;
  readonly callerId: PhoneNumber;
  readonly record: boolean;
  readonly announcementRequired: boolean;
}

/**
 * Loads the instructions for an outbound call the carrier is asking about.
 *
 * `placeCall` hands Twilio a `Url` and Twilio fetches it when the call
 * connects — so this is what turns a queued call into a dialled one. Without
 * it the carrier gets a 404 and drops the call before anyone's phone rings.
 *
 * Both `record` and `announcementRequired` are READ, never inferred from one
 * another (migration 0038). They answer different questions — "was recording
 * asked for" and "does the destination's consent rule demand an announcement"
 * — and an earlier version that derived the first from the second silently
 * refused to record every one-party destination, GB and CA among them.
 */
export async function loadOutboundCallInstructions(
  orgId: OrgId,
  deps: TelephonyDeps,
  callId: string,
): Promise<OutboundCallInstructions | undefined> {
  const row = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        ciphertext: schema.calls.counterpartyCiphertext,
        direction: schema.calls.direction,
        phoneNumberId: schema.calls.phoneNumberId,
        recordRequested: schema.calls.recordRequested,
        announcementRequired: schema.calls.announcementRequired,
      })
      .from(schema.calls)
      .where(eq(schema.calls.id, callId))
      .limit(1);
    return rows[0];
  });

  if (row?.direction !== 'outbound') return undefined;

  /* Read after the row is known present, so the narrowing carries into the
     query below rather than needing a non-null assertion there. */
  const phoneNumberId = row.phoneNumberId;
  if (phoneNumberId === null) return undefined;

  const number = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ e164: schema.phoneNumbers.e164 })
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.id, phoneNumberId))
      .limit(1);
    return rows[0];
  });

  if (number === undefined) return undefined;

  const dataKey = await loadOrgDataKey(orgId, deps.keys);

  return {
    to: openCounterparty(dataKey, orgId, callId, row.ciphertext),
    callerId: number.e164 as PhoneNumber,
    record: row.recordRequested,
    announcementRequired: row.announcementRequired,
  };
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
