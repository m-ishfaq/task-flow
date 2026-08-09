import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type CardId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { enforce } from '@taskflow/policy';
import { recordingAttachedToCard, recordingDetachedFromCard } from './events.js';
import { envelopeOf, orgOf, userOf, type TelephonyActor } from './shared.js';

/**
 * Attaching call recordings to Work cards (ai/phase-7-voice.md §3.9, §7.5).
 *
 * ## No second attachment pipeline
 *
 * A recording attached to a card does NOT go through Work's presign →
 * magic-byte → virus-scan pipeline a second time. The file already passed
 * through this phase's own trusted ingestion (§3.6): it arrived from the
 * carrier over a signature-verified callback and was written to storage by the
 * server, never by a browser. Re-running an upload pipeline over it would be
 * theatre suggesting a threat model that is not the real one.
 *
 * Attaching is a row in a join table. The FK is the enforcement — both sides
 * carry `org_id` and reference COMPOSITE keys, so a recording can never be
 * attached to another tenant's card even if this function got it wrong.
 *
 * ## TWO permissions, checked separately, and that is the whole point
 *
 * `card:read` AND `recording:read`. §3.9 names this as the same "two
 * authorization questions, deliberately not merged" distinction CLAUDE.md
 * documents for Work's card detail and Docs' page comments.
 *
 * Concretely: MEMBER holds `card:read` and does NOT hold `recording:read` —
 * that is Admin-and-Owner. So a member can see the card and must not learn that
 * a recording hangs off it. Collapsing the two checks into one would either
 * stop admins attaching recordings to cards members can see, or disclose the
 * existence of recordings to everyone who can open the card. Neither is what
 * the permission catalog says.
 */

export async function attachRecordingToCard(
  actor: TelephonyActor,
  input: { readonly recordingId: string; readonly cardId: CardId },
): Promise<void> {
  /* Both, separately. Not one check that happens to cover both. */
  enforce(actor.subject, 'recording:read');
  enforce(actor.subject, 'card:update');

  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    /* Existence is checked here so the caller gets a clean 404 rather than a
       foreign-key violation surfacing as a 500 — the CONSTRAINT is still what
       makes the cross-tenant case impossible, this is just the error message. */
    const recording = await tx
      .select({ id: schema.recordings.id })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, input.recordingId))
      .limit(1);

    if (recording[0] === undefined) throw errors.notFound('No such recording.');

    await tx
      .insert(schema.recordingCards)
      .values({
        orgId,
        recordingId: input.recordingId,
        cardId: input.cardId,
        attachedBy: userOf(actor),
      })
      /* Attaching twice is success. A double-click is not a conflict, and the
         primary key already makes the second one a no-op. */
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        recordingAttachedToCard,
        { recordingId: input.recordingId, cardId: input.cardId },
        envelopeOf(actor),
      ),
    ]);
  });
}

export async function detachRecordingFromCard(
  actor: TelephonyActor,
  input: { readonly recordingId: string; readonly cardId: CardId },
): Promise<void> {
  enforce(actor.subject, 'recording:read');
  enforce(actor.subject, 'card:update');

  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    await tx
      .delete(schema.recordingCards)
      .where(
        and(
          eq(schema.recordingCards.recordingId, input.recordingId),
          eq(schema.recordingCards.cardId, input.cardId),
        ),
      );

    await outboxWriter.append(tx, [
      createEvent(
        recordingDetachedFromCard,
        { recordingId: input.recordingId, cardId: input.cardId },
        envelopeOf(actor),
      ),
    ]);
  });
}

export interface AttachedRecording {
  readonly recordingId: string;
  readonly callId: string;
  readonly status: string;
  readonly durationSeconds: number | null;
  readonly attachedAt: Date;
}

/**
 * The recordings on a card.
 *
 * `recording:read` is required, and a member who lacks it gets FORBIDDEN rather
 * than an empty list. An empty list would be the friendlier-looking answer and
 * the wrong one: it is indistinguishable from "this card has no recordings",
 * which teaches the caller nothing true and quietly hides the existence of a
 * control.
 */
export async function listCardRecordings(
  actor: TelephonyActor,
  input: { readonly cardId: CardId },
): Promise<readonly AttachedRecording[]> {
  enforce(actor.subject, 'recording:read');
  enforce(actor.subject, 'card:read');

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        recordingId: schema.recordings.id,
        callId: schema.recordings.callId,
        status: schema.recordings.status,
        durationSeconds: schema.recordings.durationSeconds,
        attachedAt: schema.recordingCards.attachedAt,
      })
      .from(schema.recordingCards)
      .innerJoin(schema.recordings, eq(schema.recordings.id, schema.recordingCards.recordingId))
      .where(eq(schema.recordingCards.cardId, input.cardId));

    return rows.map((row) => ({
      recordingId: row.recordingId,
      callId: row.callId,
      status: row.status,
      durationSeconds: row.durationSeconds,
      attachedAt: row.attachedAt,
    }));
  });
}
