import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { enforce } from '@taskflow/policy';
import { recordingDownloaded, recordingStarted } from './events.js';
import { envelopeOf, orgOf, webhookContext, type TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';

/**
 * Call recordings (ai/phase-7-voice.md §3.6). ⚠ Human-review surface — this
 * file decides who is handed audio of a real conversation.
 *
 * ## The one invariant, borrowed from attachments
 *
 * `presignDownload` is called for exactly one kind of row: `status = 'stored'`.
 * That is the same single decision `work/attachment.service.ts` is built around,
 * and every other rule here exists to keep it correct.
 *
 * What is DIFFERENT from attachments is the direction of trust. An attachment
 * arrives from an untrusted browser, so it is magic-byte checked and virus
 * scanned before it is downloadable. A recording arrives from the carrier over a
 * signature-verified callback — it is the carrier's own recording of a call this
 * system placed — so there is no scan step, and adding a theatrical one would
 * suggest a threat model that is not the real one here. What carries over
 * unchanged is that a presigned URL is the only door.
 *
 * ## Permissions, and why they are two different questions
 *
 * `recording:read` is Admin-and-Owner (absent from Member entirely) and lets
 * someone know a recording exists. `recording:export` is OWNER-ONLY and, with
 * step-up re-authentication, is what actually produces bytes. Neither is a
 * choice this phase made — `packages/policy/src/roles.ts` decided it before this
 * phase existed, and its header names `recording:export` as one of the two cases
 * that prove roles are not a hierarchy.
 */

export interface RecordingRecord {
  readonly recordingId: string;
  readonly callId: string;
  readonly status: string;
  readonly durationSeconds: number | null;
  readonly createdAt: Date;
}

/**
 * Registers a recording the carrier has told us about, and marks the call as
 * recorded.
 *
 * Called from the signature-verified webhook. The `recording_started_at` write
 * is what the `calls_recording_after_announcement` CHECK constraint adjudicates:
 * if an announcement was required and none has been recorded as played, this
 * INSERT's sibling UPDATE fails and the whole transaction rolls back. That is
 * the consent gate being enforced by the database rather than by this function
 * remembering to ask.
 */
export async function registerRecording(
  orgId: OrgId,
  input: {
    readonly callId: string;
    readonly providerSid: string;
    readonly providerUrl: string;
    readonly durationSeconds: number | undefined;
    readonly requestId: string;
  },
): Promise<{ readonly recordingId: string }> {
  const recordingId = newId<'RecordingId'>();

  await withOrgScope(orgId, async (tx) => {
    await tx
      .insert(schema.recordings)
      .values({
        id: recordingId,
        orgId,
        callId: input.callId,
        providerSid: input.providerSid,
        providerUrl: input.providerUrl,
        status: 'pending',
        ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      })
      /* The carrier retries recording callbacks. Unique on (org, provider_sid),
         so a replay is a no-op rather than a second row pointing at the same
         audio — and a second row would mean a second ingest, a second object,
         and double the storage for one conversation. */
      .onConflictDoNothing({
        target: [schema.recordings.orgId, schema.recordings.providerSid],
      });

    /* Refused by CHECK if a required announcement never played. */
    await tx
      .update(schema.calls)
      .set({ recordingStartedAt: new Date() })
      .where(eq(schema.calls.id, input.callId));

    await outboxWriter.append(tx, [
      createEvent(
        recordingStarted,
        { callId: input.callId, recordingId },
        webhookContext(orgId, input.requestId),
      ),
    ]);
  });

  return { recordingId };
}

export async function listRecordings(
  actor: TelephonyActor,
  input: { readonly callId: string },
): Promise<readonly RecordingRecord[]> {
  /* `recording:read` alone — no target. Every telephony permission is a flat
     role grant with no tuple or ancestor component (§6.3), so `can()`'s
     role-only path is the whole check and there is no target to build. */
  enforce(actor.subject, 'recording:read');

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        id: schema.recordings.id,
        callId: schema.recordings.callId,
        status: schema.recordings.status,
        durationSeconds: schema.recordings.durationSeconds,
        createdAt: schema.recordings.createdAt,
      })
      .from(schema.recordings)
      .where(eq(schema.recordings.callId, input.callId));

    return rows.map((row) => ({
      recordingId: row.id,
      callId: row.callId,
      status: row.status,
      durationSeconds: row.durationSeconds,
      createdAt: row.createdAt,
    }));
  });
}

/**
 * Issues a short-lived URL to the audio.
 *
 * Three gates, and the route adds a fourth. `recording:export` is Owner-only;
 * the route that reaches this is declared `stepUp: true`, so a credential
 * proven more than five minutes ago is refused; the row must be `stored`; and
 * the download itself is an audited event.
 *
 * Sixty seconds, matching attachments. A presigned URL carries its own
 * authorization in the query string — anyone holding it can fetch the object
 * until it expires — so the window is the blast radius of a leaked link.
 */
export async function presignRecording(
  actor: TelephonyActor,
  deps: TelephonyDeps,
  input: { readonly recordingId: string },
): Promise<{ readonly url: string; readonly expiresInSeconds: number }> {
  enforce(actor.subject, 'recording:export');

  const storage = deps.storage;
  if (storage === undefined) {
    throw errors.serviceUnavailable('Recording storage is not configured on this instance.');
  }

  const expiresInSeconds = 60;
  const orgId = orgOf(actor);

  const row = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.recordings.id,
        callId: schema.recordings.callId,
        status: schema.recordings.status,
        storageKey: schema.recordings.storageKey,
      })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, input.recordingId))
      .limit(1);

    const recording = rows[0];
    if (recording === undefined) throw errors.notFound();

    /* THE invariant. Anything not `stored` has either not been ingested yet or
       failed, and in both cases there is nothing to hand out. 404 rather than
       403 — the caller does not need to learn the difference. */
    if (recording.status !== 'stored' || recording.storageKey === null) throw errors.notFound();

    /* The audit entry is written BEFORE the URL is issued, in the same
       transaction as the read that authorized it. Writing it afterwards means a
       crash between the two produces a downloadable URL with no record that
       anyone asked for it — and "who took a copy" is the question this event
       exists to answer. */
    await outboxWriter.append(tx, [
      createEvent(
        recordingDownloaded,
        { recordingId: recording.id, callId: recording.callId },
        envelopeOf(actor),
      ),
    ]);

    /* Rebuilt as a literal, not returned as-is: `recording.storageKey` is
       narrowed to `string` by the check above, and reconstructing it here is
       what carries that narrowing across the closure boundary — the
       alternative is a type assertion at the call site, which is banned
       (guardrail: no `as`/`!` papering over a type the compiler cannot
       otherwise prove). */
    return { id: recording.id, callId: recording.callId, storageKey: recording.storageKey };
  });

  const url = await storage.presignDownload(row.storageKey, expiresInSeconds);
  return { url, expiresInSeconds };
}
