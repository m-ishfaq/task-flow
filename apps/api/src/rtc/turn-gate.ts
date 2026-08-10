import { and, countRows, eq, gte, lt, outboxWriter, schema, withOrgScope } from '@taskflow/db';
import type { OrgId, UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { turnCredentialRefused } from './events.js';
import { envelopeOf, type RtcActor } from './shared.js';

/**
 * THE TURN gate (ai/phase-13-webrtc.md §3.4). ⚠ Human-review surface: this file
 * decides whether to hand out a capability to relay bytes on this deployment's
 * bandwidth bill.
 *
 * ## The gate ships before the thing it gates
 *
 * Phase 7 Wave 1's build-order constraint, applied again. An open TURN relay is
 * the WebRTC analogue of unmetered outbound calling: strangers' traffic, your
 * bill, and no user-visible symptom until the invoice. A control retrofitted
 * after the capability it should have gated is the control most likely to have a
 * hole nobody has looked for.
 *
 * ## The order of the checks is the control
 *
 *   1. **Org freeze.** `identity.orgs.status`, the same column the telephony
 *      gate reads. A suspended org gets nothing, checked first because it is the
 *      cheapest refusal and the one an operator most needs to be absolute.
 *   2. **Participation.** The caller must be a participant of a session that is
 *      not over. This is NOT the authorization decision about the conversation —
 *      that is `can()` on the channel, made by the route. It is narrower on
 *      purpose: a person who can read the channel may JOIN the call; only a
 *      person actually in the call gets bandwidth spent on them.
 *   3. **Issuance budget.** A durable count over a rolling window.
 *
 * ## The budget is counted in Postgres, and that is the whole point
 *
 * An in-process counter forgives everyone on restart, which is precisely the
 * state an attacker restarts you to reach. `rtc.turn_issuance` is the durable
 * control, and it has the same relationship to any future in-memory limiter that
 * `comms.spend_ledger` has to the telephony velocity limiter: one stops a burst
 * inside a window, the other stops the bill.
 *
 * ## One row per credential MINTED, never one per request
 *
 * Written inside the deciding transaction, so a refused request consumes no
 * budget — otherwise an attacker could exhaust a legitimate org's daily
 * allowance with requests that were always going to be refused, which is a
 * denial of service inflicted through a control meant to prevent one. That is
 * the same reasoning that puts the telephony velocity limiter LAST.
 */

export type TurnRefusalReason =
  | 'org_suspended'
  | 'not_a_participant'
  | 'session_over'
  | 'issuance_cap';

export interface TurnAllowed {
  readonly allowed: true;
  readonly issuedInWindow: number;
  readonly capPerWindow: number;
}

export interface TurnRefused {
  readonly allowed: false;
  readonly reason: TurnRefusalReason;
  readonly issuedInWindow: number;
  readonly capPerWindow: number;
}

export type TurnDecision = TurnAllowed | TurnRefused;

export interface TurnGateConfig {
  readonly capPerWindow: number;
  readonly ttlSeconds: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Decides, and — only when the answer is yes — records the issuance.
 *
 * Decision and record are ONE transaction on purpose. Split into "check" then
 * "write", two callers racing at the cap boundary both read the same count and
 * both write, so the cap is a line an org steps over as many times as it has
 * concurrency. Same shape as `claimForScanning`'s conditional claim.
 *
 * Returns a verdict rather than throwing, because the caller has two obligations
 * on a refusal — an error to the user AND a `turn_credential.refused` event —
 * and a thrown error makes it easy to satisfy the first and forget the second.
 */
export async function checkTurnAllowed(
  request: { readonly orgId: OrgId; readonly userId: UserId; readonly sessionId: string },
  config: TurnGateConfig,
): Promise<TurnDecision> {
  return withOrgScope(request.orgId, async (tx) => {
    /* --- 1. Org freeze ---------------------------------------------------- */
    const orgRows = await tx
      .select({ status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, request.orgId))
      .limit(1);

    const since = new Date(Date.now() - WINDOW_MS);

    /* Counted before every refusal path so the event carries the same figures
       whichever check fired — an alert that reports 0/500 for one reason and
       real numbers for another is an alert nobody can read. */
    const countRowsResult = await tx
      .select({ total: countRows(schema.rtcTurnIssuance.id) })
      .from(schema.rtcTurnIssuance)
      .where(gte(schema.rtcTurnIssuance.issuedAt, since));

    /* Postgres COUNT comes back as a STRING through the driver, and
       `Number(undefined)` is NaN — which compares false against every
       threshold, so a parsing slip here reads as "under the cap" forever. The
       same trap `readSpendState` documents for SUM. */
    const issuedInWindow = Math.max(0, Number.parseInt(countRowsResult[0]?.total ?? '0', 10) || 0);

    const refuse = (reason: TurnRefusalReason): TurnRefused => ({
      allowed: false,
      reason,
      issuedInWindow,
      capPerWindow: config.capPerWindow,
    });

    if (orgRows[0]?.status !== 'active') return refuse('org_suspended');

    /* --- 2. Participation, and the session is still live ------------------ */
    const rows = await tx
      .select({
        state: schema.rtcParticipants.state,
        sessionStatus: schema.rtcSessions.status,
      })
      .from(schema.rtcParticipants)
      .innerJoin(
        schema.rtcSessions,
        and(
          eq(schema.rtcSessions.id, schema.rtcParticipants.sessionId),
          eq(schema.rtcSessions.orgId, schema.rtcParticipants.orgId),
        ),
      )
      .where(
        and(
          eq(schema.rtcParticipants.sessionId, request.sessionId),
          eq(schema.rtcParticipants.userId, request.userId),
        ),
      )
      .limit(1);

    const participant = rows[0];
    if (participant === undefined) return refuse('not_a_participant');
    if (participant.sessionStatus === 'ended') return refuse('session_over');

    /* Someone who declined or left is a participant ROW and not a participant.
       Reissuing to them would let a declined invitee hold a relay credential
       for the whole call they refused to be in. */
    if (participant.state !== 'invited' && participant.state !== 'joined') {
      return refuse('not_a_participant');
    }

    /* --- 3. Durable issuance budget --------------------------------------- */
    /* `>=` rather than `>`: at exactly the cap the budget is spent. `>` would
       make the cap a line the org steps over exactly once. */
    if (issuedInWindow >= config.capPerWindow) return refuse('issuance_cap');

    /* Recorded HERE, in the deciding transaction. See the header. */
    await tx.insert(schema.rtcTurnIssuance).values({
      id: newId<'TurnIssuanceId'>(),
      orgId: request.orgId,
      sessionId: request.sessionId,
      userId: request.userId,
      ttlSeconds: config.ttlSeconds,
    });

    return { allowed: true, issuedInWindow: issuedInWindow + 1, capPerWindow: config.capPerWindow };
  });
}

/**
 * Records a refusal as a domain event, in its OWN transaction.
 *
 * Its own, because the caller throws immediately afterward — an event appended
 * to the transaction that then rolls back is an event that never happened, and
 * the refusal would be exactly as silent as having no event at all. The
 * telephony gate's `emitRefusal` is the same shape for the same reason.
 */
export async function emitTurnRefusal(actor: RtcActor, decision: TurnRefused): Promise<void> {
  await withOrgScope(actor.subject.orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        turnCredentialRefused,
        {
          reason: decision.reason,
          issuedInWindow: decision.issuedInWindow,
          capPerWindow: decision.capPerWindow,
        },
        envelopeOf(actor),
      ),
    ]);
  });
}

/**
 * Deletes issuance rows older than the window (§3.4's retention note).
 *
 * Nothing outside the rolling window can change a decision the gate makes, so
 * this frees rows without weakening the control. Exported rather than scheduled
 * here: which process runs a sweep is a deployment decision, and Phase 7's
 * `RECORDING_INGEST_ENABLED` is the precedent for making that explicit.
 *
 * DELETE is the only write grant this table has besides INSERT — never UPDATE —
 * so a sweep can free rows and nothing can rewrite one to say a credential was
 * issued to someone else, or at another time. See migration 0041's own header.
 */
export async function pruneTurnIssuance(orgId: OrgId, olderThan: Date): Promise<number> {
  return withOrgScope(orgId, async (tx) => {
    const deleted = await tx
      .delete(schema.rtcTurnIssuance)
      .where(lt(schema.rtcTurnIssuance.issuedAt, olderThan))
      .returning({ id: schema.rtcTurnIssuance.id });
    return deleted.length;
  });
}
