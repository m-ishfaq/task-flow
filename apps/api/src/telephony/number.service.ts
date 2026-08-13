import { and, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type AvailableNumber, type OrgId, type PhoneNumber } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { InboundRoute, type InboundRouteConfig } from '@taskflow/telephony';
import { phoneNumberPurchased, phoneNumberReleased, phoneNumberRouteChanged } from './events.js';
import { emitRefusal, refusalMessage } from './refusal.js';
import { checkOutboundAllowed, notifySpendThresholds, recordSpend } from './spend-gate.js';
import { ensureSubaccount } from './subaccount.service.js';
import { envelopeOf, orgOf, userOf, type TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';

/**
 * Phone number provisioning (ai/phase-7-voice.md Wave 2).
 *
 * Every route into this file is Owner-only by the permission catalog:
 * `phoneNumber:purchase` and `phoneNumber:release` are not on Admin, and
 * `packages/policy/src/roles.ts`' own header names them as the reason roles are
 * not modelled as a hierarchy. This phase does not choose that; it is the first
 * consumer of a shape the matrix test has been asserting with no caller.
 *
 * ## Buying a number goes through the SAME gate as placing a call
 *
 * A number costs about a dollar a month, and buying them in a loop is a real
 * way to spend an org's balance without ever dialling anything. §3.3 names
 * `purchaseNumber` explicitly as one of the three paths through
 * `checkOutboundAllowed`, and this is that call site: the alternative — gating
 * only the things that "feel" like spending — is exactly how a control acquires
 * a hole.
 */

export interface NumberRecord {
  readonly phoneNumberId: string;
  readonly e164: PhoneNumber;
  readonly isoCountry: string;
  readonly purchasedAt: Date;
  readonly inboundRoute: InboundRouteConfig | null;
}

export async function searchNumbers(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: {
    readonly isoCountry: string;
    readonly areaCode?: string | undefined;
    readonly limit: number;
  },
): Promise<readonly AvailableNumber[]> {
  const account = await ensureSubaccount(actor, deps);

  /* A search does not spend, so it does not pass the gate — but it is still
     rate-limited by the ordinary per-route limiter, because an unbounded search
     loop against the carrier is its own kind of abuse. */
  return deps.telephony.searchAvailableNumbers({
    subaccountSid: account.subaccountSid,
    isoCountry: input.isoCountry,
    ...(input.areaCode === undefined ? {} : { areaCode: input.areaCode }),
    limit: input.limit,
  });
}

export async function purchaseNumber(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: { readonly phoneNumber: PhoneNumber },
): Promise<NumberRecord> {
  const orgId = orgOf(actor);
  const account = await ensureSubaccount(actor, deps);

  const estimatedCents = await deps.telephony.estimateCostCents({
    kind: 'number_purchase',
    to: input.phoneNumber,
  });

  const decision = await checkOutboundAllowed(
    {
      orgId,
      userId: userOf(actor),
      kind: 'number_purchase',
      to: input.phoneNumber,
      estimatedCents,
    },
    { defaultCapCents: deps.defaultSpendCapCents },
  );

  if (!decision.allowed) {
    /* The refusal is BOTH an error to the caller and an event to the outbox —
       §4's argument for why `spend.limit_exceeded` exists at all. Throwing
       without emitting would make a spend cap that stops calls and tells nobody
       why. `refuseOutbound` in call.service.ts does the same, and is the only
       other place that may. */
    await emitRefusal(actor, decision, 'number_purchase', estimatedCents);
    throw errors.quotaExceeded(refusalMessage(decision.reason));
  }

  const phoneNumberId = newId<'PhoneNumberId'>();

  /* The carrier call happens OUTSIDE the transaction. Holding a Postgres
     transaction open across a third-party round trip pins a pooled connection
     for the length of someone else's outage. */
  const purchased = await deps.telephony.purchaseNumber({
    subaccountSid: account.subaccountSid,
    phoneNumber: input.phoneNumber,
    voiceUrl: `${deps.webhookOrigin ?? ''}/telephony/voice/${phoneNumberId}`,
    smsUrl: `${deps.webhookOrigin ?? ''}/telephony/sms/${phoneNumberId}`,
  });

  const purchasedNumber = await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.phoneNumbers).values({
      id: phoneNumberId,
      orgId,
      e164: purchased.phoneNumber,
      providerSid: purchased.sid,
      isoCountry: 'US',
      purchasedBy: userOf(actor),
    });

    /* The ledger row lands in the SAME transaction as the record of the
       purchase (§3.4). A number bought and not charged against the cap is a cap
       that can be walked past one number at a time. */
    await recordSpend(
      tx,
      orgId,
      {
        id: newId<'SpendLedgerId'>(),
        kind: 'number_purchase',
        estimatedCents: purchased.monthlyCostCents,
        providerSid: purchased.sid,
        decision,
      },
      envelopeOf(actor),
    );

    await outboxWriter.append(tx, [
      createEvent(phoneNumberPurchased, { phoneNumberId, isoCountry: 'US' }, envelopeOf(actor)),
    ]);

    return {
      phoneNumberId,
      e164: purchased.phoneNumber,
      isoCountry: 'US',
      purchasedAt: new Date(),
      inboundRoute: null,
    };
  });

  /* The usage alert, AFTER the commit — see `notifySpendThresholds`. */
  await notifySpendThresholds(orgId, decision, deps.mail);

  return purchasedNumber;
}

export async function releaseNumber(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: { readonly phoneNumberId: string },
): Promise<void> {
  const orgId = orgOf(actor);

  const row = await loadNumber(orgId, input.phoneNumberId);
  if (row === undefined) throw errors.notFound('No such phone number.');

  const account = await ensureSubaccount(actor, deps);
  await deps.telephony.releaseNumber({
    subaccountSid: account.subaccountSid,
    numberSid: row.providerSid,
  });

  await withOrgScope(orgId, async (tx) => {
    /* Soft-released, not deleted. The call log references this row, and a
       hard delete would either cascade away the history of every call made on
       the number or fail on the FK. `released_at` also takes the row out of the
       partial unique index, so the carrier genuinely can resell the number to
       someone else later. */
    await tx
      .update(schema.phoneNumbers)
      .set({ releasedAt: new Date() })
      .where(eq(schema.phoneNumbers.id, input.phoneNumberId));

    await outboxWriter.append(tx, [
      createEvent(phoneNumberReleased, { phoneNumberId: input.phoneNumberId }, envelopeOf(actor)),
    ]);
  });
}

export async function listNumbers(orgId: OrgId): Promise<readonly NumberRecord[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.phoneNumbers.id,
        e164: schema.phoneNumbers.e164,
        isoCountry: schema.phoneNumbers.isoCountry,
        purchasedAt: schema.phoneNumbers.purchasedAt,
        inboundRoute: schema.phoneNumbers.inboundRoute,
      })
      .from(schema.phoneNumbers)
      .where(isNull(schema.phoneNumbers.releasedAt));

    return rows.map((row) => ({
      phoneNumberId: row.id,
      e164: row.e164 as PhoneNumber,
      isoCountry: row.isoCountry,
      purchasedAt: row.purchasedAt,
      inboundRoute: parseRoute(row.inboundRoute),
    }));
  });
}

/**
 * Sets a number's inbound routing.
 *
 * Parsed with the closed `InboundRoute` schema on the way IN, and again on the
 * way out (`parseRoute`). Validating only on write would trust that every row
 * already in the table was written by this version of this code — and a routing
 * config is executed as markup by a third party, so a malformed one is not a
 * rendering bug, it is a call placed somewhere nobody chose.
 */
export async function setInboundRoute(
  actor: TelephonyActor,
  input: { readonly phoneNumberId: string; readonly route: unknown },
): Promise<void> {
  const route = InboundRoute.parse(input.route);

  await withOrgScope(orgOf(actor), async (tx) => {
    const updated = await tx
      .update(schema.phoneNumbers)
      .set({ inboundRoute: route })
      .where(
        and(
          eq(schema.phoneNumbers.id, input.phoneNumberId),
          isNull(schema.phoneNumbers.releasedAt),
        ),
      )
      .returning({ id: schema.phoneNumbers.id });

    if (updated.length === 0) throw errors.notFound('No such phone number.');

    await outboxWriter.append(tx, [
      createEvent(
        phoneNumberRouteChanged,
        { phoneNumberId: input.phoneNumberId },
        envelopeOf(actor),
      ),
    ]);
  });
}

/** Reads a number row, including the carrier sid a release needs. */
export async function loadNumber(
  orgId: OrgId,
  phoneNumberId: string,
): Promise<{ readonly providerSid: string; readonly e164: PhoneNumber } | undefined> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ providerSid: schema.phoneNumbers.providerSid, e164: schema.phoneNumbers.e164 })
      .from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.id, phoneNumberId), isNull(schema.phoneNumbers.releasedAt)))
      .limit(1);

    const row = rows[0];
    return row === undefined
      ? undefined
      : { providerSid: row.providerSid, e164: row.e164 as PhoneNumber };
  });
}

/**
 * Re-parses a stored route, returning null rather than throwing.
 *
 * A row written by an older build with a shape this one no longer accepts must
 * not make the whole number list 500. Null means "no routing configured", which
 * the TwiML layer answers with a polite unavailable message — a safe default for
 * a config it cannot understand.
 */
function parseRoute(value: unknown): InboundRouteConfig | null {
  if (value === null || value === undefined) return null;
  const parsed = InboundRoute.safeParse(value);
  return parsed.success ? parsed.data : null;
}
