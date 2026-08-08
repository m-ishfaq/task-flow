import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { enforce } from '@taskflow/policy';
import { redactTranscript } from '@taskflow/telephony';
import { transcriptionCompleted } from './events.js';
import { orgOf, webhookContext, type TelephonyActor } from './shared.js';

/**
 * Transcripts (ai/phase-7-voice.md §3.7).
 *
 * PLAN.md §8.5: "PII in transcripts — Automatic redaction pass (card numbers,
 * national IDs) **before storage**."
 *
 * ## The whole design is one line, and it is the order of two statements
 *
 * `redactTranscript` runs, and its OUTPUT is what `INSERT` receives. The raw
 * text is a local variable that is never written anywhere. A pass that ran after
 * the insert and then updated the row would leave a window — however short —
 * where the unredacted transcript exists at rest, in the WAL, and in whatever
 * replication or backup touched that write.
 *
 * Two things make that hard to get wrong later:
 *
 *   - `comms.transcripts` has NO `raw_text` column. A schema with somewhere to
 *     put the unredacted text is a schema where somebody eventually does.
 *   - `redactTranscript` is a pure function in `packages/telephony` with no
 *     database access at all, so it cannot be called in the wrong order — there
 *     is nothing for it to be out of order with.
 *
 * ## Twilio's own transcription, per §7.4
 *
 * Resolved at Wave 2: the carrier transcribes, and the text arrives on a
 * signature-verified callback. No second external provider, no second
 * credential, no second rate card the spend gate would have to learn about. The
 * redaction requirement is provider-agnostic, so swapping to a dedicated
 * speech-to-text provider later changes one method behind `TelephonyProvider`
 * rather than this pipeline.
 */

export interface TranscriptRecord {
  readonly transcriptId: string;
  readonly recordingId: string;
  readonly text: string;
  readonly createdAt: Date;
}

/**
 * Stores a transcript, redacted.
 *
 * `rawText` is the carrier's output and is consumed here — it is never
 * returned, logged, or written. The only thing that leaves this function's
 * scope is the redacted form and a count of which rules fired.
 */
export async function storeTranscript(
  orgId: OrgId,
  input: {
    readonly recordingId: string;
    readonly rawText: string;
    readonly language: string | undefined;
    readonly requestId: string;
  },
): Promise<{ readonly transcriptId: string }> {
  /* BEFORE the insert. Not after, not in a trigger, not in a follow-up job. */
  const redacted = redactTranscript(input.rawText);

  const transcriptId = newId<'TranscriptId'>();

  await withOrgScope(orgId, async (tx) => {
    await tx
      .insert(schema.transcripts)
      .values({
        id: transcriptId,
        orgId,
        recordingId: input.recordingId,
        text: redacted.text,
        ...(input.language === undefined ? {} : { language: input.language }),
        redactionCounts: redacted.counts,
      })
      /* The carrier retries transcription callbacks, and the unique index is on
         (org, recording). A replay is a no-op rather than a second transcript
         of the same audio. */
      .onConflictDoNothing({
        target: [schema.transcripts.orgId, schema.transcripts.recordingId],
      });

    await outboxWriter.append(tx, [
      createEvent(
        transcriptionCompleted,
        {
          recordingId: input.recordingId,
          transcriptId,
          /* Counts only. What the rules MATCHED would put the PII into the
             audit log by the one route `REDACTION_PATHS` cannot see. */
          redactionCounts: redacted.counts,
        },
        webhookContext(orgId, input.requestId),
      ),
    ]);
  });

  return { transcriptId };
}

/**
 * Reads a transcript.
 *
 * `recording:read` — Admin-and-Owner. A transcript is a written record of a
 * private conversation, so it sits behind the recording permission rather than
 * `call:read`: being allowed to see that a call happened is a different question
 * from being allowed to read what was said, the same "two authorization
 * questions, deliberately not merged" distinction CLAUDE.md documents for Work's
 * card detail.
 */
export async function getTranscript(
  actor: TelephonyActor,
  input: { readonly recordingId: string },
): Promise<TranscriptRecord> {
  enforce(actor.subject, 'recording:read');

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        id: schema.transcripts.id,
        recordingId: schema.transcripts.recordingId,
        text: schema.transcripts.text,
        createdAt: schema.transcripts.createdAt,
      })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.recordingId, input.recordingId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw errors.notFound('No transcript for that recording.');

    return {
      transcriptId: row.id,
      recordingId: row.recordingId,
      text: row.text,
      createdAt: row.createdAt,
    };
  });
}
