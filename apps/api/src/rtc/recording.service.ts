import { and, desc, eq, outboxWriter, schema, withOrgScope } from '@taskflow/db';
import { errors, type ChannelId } from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { enforceOnChannel, loadChannel } from '../chat/shared.js';
import {
  rtcRecordingConsented,
  rtcRecordingDeclined,
  rtcRecordingDownloaded,
  rtcRecordingRequested,
  rtcRecordingStarted,
  rtcRecordingStopped,
  rtcRecordingStored,
} from './events.js';
import { answerRecordingConsent, resetRecordingConsent } from './participants.js';
import { envelopeOf, loadSession, orgOf, userOf, type RtcActor } from './shared.js';
import type { RtcDeps } from './deps.js';

/**
 * Recording an in-app call (ai/phase-13-webrtc.md §3.9). ⚠ Human-review surface:
 * this file decides whether a conversation between real people is captured.
 *
 * ## Recording was deferred from Wave 1 with a condition, and this is it
 *
 * §3.9: "if it ever lands, the consent gate applies exactly as it does for
 * PSTN. An in-app call is no less a recorded conversation." Phase 7 met that
 * bar with three layers and only the third is a thing the database will not let
 * be wrong. The same three exist here:
 *
 *   1. **A decision.** `requestRecording` moves the session to `pending` and
 *      emits an event; nothing is captured yet.
 *   2. **A code path.** `startRecording` is the only way to reach `active`, and
 *      it refuses unless every joined participant has agreed.
 *   3. **A constraint.** `sessions_recording_needs_consent` refuses the UPDATE
 *      outright when `consent_count < joined_count` (migration 0042). This is
 *      the layer that survives someone rewriting (2) wrongly.
 *
 * §3.5's standard, restated for this phase: a UI affordance a determined caller
 * could skip is not a control.
 *
 * ## Consent is per RECORDING, not per session
 *
 * `stopRecording` clears every answer. Agreeing once must not make you
 * recordable for the rest of the call — that is the difference between "you
 * agreed to be recorded" and "you agreed to be recordable", and only the first
 * is a thing anybody actually agreed to.
 *
 * ## Every participant can veto, including the person who asked
 *
 * There is no admin override. A permission that let an owner record over
 * somebody's objection would make the consent gate decorative, and the org's
 * own admin is exactly who a participant most needs to be able to refuse.
 */

export interface RecordingView {
  readonly state: string;
  readonly requestedBy: string | null;
  readonly startedAt: Date | null;
  /** Who has agreed so far, and who has refused. Rendered as a checklist. */
  readonly consented: readonly string[];
  readonly declined: readonly string[];
  readonly awaiting: readonly string[];
}

/**
 * Loads the session, checks `channel:read`, and returns it.
 *
 * Every route in this file goes through here first, so the §1 rule holds for
 * recording exactly as it does for joining: the authorization question is about
 * the CHANNEL, and `rtc.participants` is consulted only for state.
 */
async function authorizedSession(actor: RtcActor, sessionId: string) {
  return withOrgScope(orgOf(actor), async (tx) => {
    const session = await loadSession(tx, sessionId);
    const channel = await loadChannel(tx, session.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:read', channel);
    return session;
  });
}

/**
 * Asks everyone in the call to agree to be recorded.
 *
 * The requester's own consent is recorded in the same transaction — they are a
 * participant too, and asking somebody to click "agree" on their own request is
 * ceremony that teaches people to click through consent dialogs.
 */
export async function requestRecording(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<void> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);
  const session = await authorizedSession(actor, input.sessionId);

  if (session.status !== 'active') {
    throw errors.conflict('Recording can only be started once the call is connected.');
  }
  if (session.recordingState === 'active' || session.recordingState === 'pending') {
    throw errors.conflict('Recording has already been requested for this call.');
  }

  await withOrgScope(orgId, async (tx) => {
    const now = new Date();

    await tx
      .update(schema.rtcSessions)
      .set({ recordingState: 'pending', recordingRequestedBy: userId, updatedAt: now })
      .where(eq(schema.rtcSessions.id, session.id));

    await answerRecordingConsent(tx, {
      sessionId: session.id,
      userId,
      agreed: true,
      now,
    });

    await outboxWriter.append(tx, [
      createEvent(rtcRecordingRequested, { sessionId: session.id }, envelopeOf(actor)),
    ]);
  });
}

/** Agrees, or refuses, to be recorded. Only ever writes the caller's own row. */
export async function answerRecording(
  actor: RtcActor,
  input: { readonly sessionId: string; readonly agreed: boolean },
): Promise<void> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);
  const session = await authorizedSession(actor, input.sessionId);

  if (session.recordingState !== 'pending') {
    throw errors.conflict('Nobody is asking to record this call.');
  }

  await withOrgScope(orgId, async (tx) => {
    const now = new Date();
    const answered = await answerRecordingConsent(tx, {
      sessionId: session.id,
      userId,
      agreed: input.agreed,
      now,
    });

    if (!answered) return;

    const events: DomainEvent[] = [
      createEvent(
        input.agreed ? rtcRecordingConsented : rtcRecordingDeclined,
        { sessionId: session.id },
        envelopeOf(actor),
      ),
    ];

    /* A refusal ends the REQUEST immediately rather than leaving it pending
       until it times out. Anything else means a participant who said no
       continues to see "waiting for consent" and cannot tell whether their
       answer registered — and the person who asked keeps waiting for an answer
       that already came. */
    if (!input.agreed) {
      await tx
        .update(schema.rtcSessions)
        .set({ recordingState: 'none', recordingRequestedBy: null, updatedAt: now })
        .where(eq(schema.rtcSessions.id, session.id));

      await resetRecordingConsent(tx, session.id, now);
    }

    await outboxWriter.append(tx, events);
  });
}

/**
 * Begins capture, once everybody has agreed.
 *
 * ## The refusal here is a courtesy; the CHECK is the control
 *
 * The `consentCount < joinedCount` test below produces a readable error. If it
 * were deleted, `sessions_recording_needs_consent` would refuse the UPDATE and
 * the caller would get an opaque 500 — worse to read, identical in effect. That
 * ordering is deliberate and is what §3.9 asks for: the database is what makes
 * recording-without-consent impossible to express, and this function only makes
 * the refusal legible.
 */
export async function startRecording(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<{ readonly recordingId: string }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);
  const session = await authorizedSession(actor, input.sessionId);

  if (session.recordingState !== 'pending') {
    throw errors.conflict('Recording has not been requested for this call.');
  }

  const recordingId = newId<'RtcRecordingId'>();

  await withOrgScope(orgId, async (tx) => {
    const now = new Date();

    /* Re-read INSIDE the transaction. The counts read by `authorizedSession`
       are from a previous transaction, and somebody joining in between is
       exactly the case that must not slip through — the CHECK would catch it,
       and catching it here means the caller is told why. */
    const current = await loadSession(tx, session.id);

    if (current.consentCount < current.joinedCount) {
      throw errors.conflict('Everyone in the call has to agree before recording can start.');
    }

    await tx
      .update(schema.rtcSessions)
      .set({ recordingState: 'active', recordingStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.rtcSessions.id, session.id),
          /* Conditional, so two people pressing start at the same instant
             produce one recording. The same claim pattern as the answer race. */
          eq(schema.rtcSessions.recordingState, 'pending'),
        ),
      );

    await tx.insert(schema.rtcRecordings).values({
      id: recordingId,
      orgId,
      sessionId: session.id,
      status: 'pending',
      /* SERVER-GENERATED, and nothing from a client reaches it. A filename in
         the key would need path escaping, which is a traversal this design
         removes rather than mitigates (Phase 3's attachments settled this). */
      storageKey: `rtc/${orgId}/${session.id}/${recordingId}.webm`,
      contentType: 'audio/webm',
      createdBy: userId,
    });

    await outboxWriter.append(tx, [
      createEvent(rtcRecordingStarted, { sessionId: session.id, recordingId }, envelopeOf(actor)),
    ]);
  });

  return { recordingId };
}

/** Ends capture and clears every consent answer — see the file header. */
export async function stopRecording(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<void> {
  const orgId = orgOf(actor);
  const session = await authorizedSession(actor, input.sessionId);

  if (session.recordingState !== 'active' && session.recordingState !== 'pending') return;

  await withOrgScope(orgId, async (tx) => {
    const now = new Date();
    const seconds =
      session.recordingStartedAt === null
        ? 0
        : Math.max(0, Math.floor((now.getTime() - session.recordingStartedAt.getTime()) / 1000));

    await tx
      .update(schema.rtcSessions)
      .set({
        /* `stopped` only if it was actually running. A request that nobody
           answered returns to `none`, so the button reads "Record" again rather
           than claiming a recording that never happened. */
        recordingState: session.recordingState === 'active' ? 'stopped' : 'none',
        recordingRequestedBy: null,
        updatedAt: now,
      })
      .where(eq(schema.rtcSessions.id, session.id));

    await resetRecordingConsent(tx, session.id, now);

    await outboxWriter.append(tx, [
      createEvent(
        rtcRecordingStopped,
        { sessionId: session.id, durationSeconds: seconds },
        envelopeOf(actor),
      ),
    ]);
  });
}

/**
 * A presigned PUT for the captured audio.
 *
 * The upload is a direct browser-to-storage PUT, the same shape attachments
 * use — the API never proxies the bytes. `signableHeaders` pinning the content
 * type is what makes the signature actually cover it; see
 * `packages/storage/src/s3.ts`, whose own test exists because the first version
 * of that guarantee was documented and false.
 */
export async function presignRecordingUpload(
  actor: RtcActor,
  deps: RtcDeps,
  input: { readonly recordingId: string; readonly bytes: number },
): Promise<{
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}> {
  if (deps.storage === undefined) {
    throw errors.serviceUnavailable('Call recording storage is not configured on this instance.');
  }

  const orgId = orgOf(actor);

  const recording = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.rtcRecordings.id,
        sessionId: schema.rtcRecordings.sessionId,
        storageKey: schema.rtcRecordings.storageKey,
        contentType: schema.rtcRecordings.contentType,
        status: schema.rtcRecordings.status,
        createdBy: schema.rtcRecordings.createdBy,
      })
      .from(schema.rtcRecordings)
      .where(eq(schema.rtcRecordings.id, input.recordingId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw errors.notFound('No such recording.');
    return row;
  });

  /* The channel check, again — a recording id is not a capability. */
  await authorizedSession(actor, recording.sessionId);

  /* Only the person capturing may upload. The browser doing the capture is the
     one that pressed start, and a presigned PUT is a write capability for an
     object key: handing it to every participant would let any of them overwrite
     the recording with content of their choosing. */
  if (recording.createdBy !== userOf(actor)) {
    throw errors.forbidden('Only the person who started the recording can upload it.');
  }

  if (recording.status !== 'pending') {
    throw errors.conflict('This recording has already been uploaded.');
  }

  /* Checked here as well as at the route boundary, because this is the value
     pinned into the SIGNATURE below — an oversized value would then be stored
     under a signature saying it was fine. Same reasoning `chat.attachments`'
     own presign gives for its identical check. */
  if (input.bytes > deps.maxRecordingBytes) {
    throw errors.validation({
      bytes: `Recordings must be ${String(deps.maxRecordingBytes)} bytes or smaller.`,
    });
  }

  /* `input.bytes`, not `deps.maxRecordingBytes` — this is what a presigned PUT
   * actually binds into its signature (`packages/storage/src/s3.ts`'s own
   * `presignUpload`: `ContentLength` is a SIGNED header). A recording's real
   * size is not known until AFTER capture stops, unlike an attachment's,
   * which the browser already knows before it asks to upload — so this route
   * exists specifically to carry that number from the client, the one place
   * that has it, to the signature that has to match it exactly.
   *
   * Signing the deployment CEILING instead — what this did before real
   * recordings existed to upload — reads as the safer number and is not: the
   * browser's own `fetch()` always sends the body's ACTUAL byte count as
   * `Content-Length` (a forbidden header name a caller cannot override), so a
   * signature pinned to the ceiling can only ever match a body that happens
   * to be exactly that many bytes. Every real recording is smaller than the
   * ceiling, so every real upload failed the signature check with a 403 —
   * caught only once `hangUp` stopped discarding recordings and a real
   * upload finally reached real storage. See ai/phase-13-webrtc.md's own
   * addendum on why nothing exercised this path until then.
   */
  const presigned = await deps.storage.presignUpload({
    key: recording.storageKey,
    contentType: recording.contentType,
    maxBytes: input.bytes,
  });

  /* The `key` is deliberately NOT returned. The client PUTs to the URL it was
     given and confirms by RECORDING ID; handing it the object key as well would
     invite a confirm keyed on a value the client supplied. */
  return {
    url: presigned.url,
    headers: presigned.headers,
    maxBytes: input.bytes,
  };
}

/** Confirms the upload landed. Idempotent — a retried confirm changes nothing new. */
export async function confirmRecordingUpload(
  actor: RtcActor,
  input: {
    readonly recordingId: string;
    readonly bytes: number;
    readonly durationSeconds: number;
  },
): Promise<void> {
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const now = new Date();

    /* Conditional on `pending`, the same shape `claimForScanning` uses: without
       it, two racing confirms both write, and a later one could overwrite a
       stored row's byte count with a stale value. */
    const stored = await tx
      .update(schema.rtcRecordings)
      .set({
        status: 'stored',
        bytes: input.bytes,
        durationSeconds: input.durationSeconds,
        storedAt: now,
      })
      .where(
        and(
          eq(schema.rtcRecordings.id, input.recordingId),
          eq(schema.rtcRecordings.status, 'pending'),
          eq(schema.rtcRecordings.createdBy, userOf(actor)),
        ),
      )
      .returning({ sessionId: schema.rtcRecordings.sessionId });

    const row = stored[0];
    if (row === undefined) return;

    await outboxWriter.append(tx, [
      createEvent(
        rtcRecordingStored,
        {
          sessionId: row.sessionId,
          recordingId: input.recordingId,
          bytes: input.bytes,
          durationSeconds: input.durationSeconds,
        },
        envelopeOf(actor),
      ),
    ]);
  });
}

/** The consent checklist for a call, for everyone in it to see. */
export async function recordingStatus(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<RecordingView> {
  const session = await authorizedSession(actor, input.sessionId);

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        userId: schema.rtcParticipants.userId,
        state: schema.rtcParticipants.state,
        consentAt: schema.rtcParticipants.recordingConsentAt,
        declinedAt: schema.rtcParticipants.recordingDeclinedAt,
      })
      .from(schema.rtcParticipants)
      .where(eq(schema.rtcParticipants.sessionId, session.id));

    const joined = rows.filter((row) => row.state === 'joined');

    return {
      state: session.recordingState,
      requestedBy: session.recordingRequestedBy,
      startedAt: session.recordingStartedAt,
      consented: joined.filter((row) => row.consentAt !== null).map((row) => row.userId),
      declined: joined.filter((row) => row.declinedAt !== null).map((row) => row.userId),
      awaiting: joined
        .filter((row) => row.consentAt === null && row.declinedAt === null)
        .map((row) => row.userId),
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Listing and download (closes §6's "recordings have no listing or playback
 * UI" — the rows and the objects were always correct, only a surface to
 * browse them from was missing).
 * -------------------------------------------------------------------------- */

export interface RecordingSummary {
  readonly recordingId: string;
  readonly sessionId: string;
  /** 'pending' | 'stored' | 'failed'. Only 'stored' has anything to download. */
  readonly status: string;
  readonly contentType: string;
  readonly bytes: number | null;
  readonly durationSeconds: number | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly storedAt: Date | null;
}

/** Bounds one page — a details panel wants "recent", not "every capture this
    conversation has ever produced". */
const MAX_RECORDINGS_PAGE = 50;

/**
 * Every recording this conversation has, newest first.
 *
 * `channel:read`, the same line every other read in this file draws — see
 * `recordingStatus`'s own shape. A recording id is not itself a capability
 * (§ below on `presignRecordingDownload`); this is the list a Calls tab or a
 * call card resolves one from.
 */
export async function listRecordingsForChannel(
  actor: RtcActor,
  input: { readonly channelId: ChannelId; readonly limit?: number },
): Promise<readonly RecordingSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    return tx
      .select({
        recordingId: schema.rtcRecordings.id,
        sessionId: schema.rtcRecordings.sessionId,
        status: schema.rtcRecordings.status,
        contentType: schema.rtcRecordings.contentType,
        bytes: schema.rtcRecordings.bytes,
        durationSeconds: schema.rtcRecordings.durationSeconds,
        createdBy: schema.rtcRecordings.createdBy,
        createdAt: schema.rtcRecordings.createdAt,
        storedAt: schema.rtcRecordings.storedAt,
      })
      .from(schema.rtcRecordings)
      .innerJoin(schema.rtcSessions, eq(schema.rtcSessions.id, schema.rtcRecordings.sessionId))
      .where(eq(schema.rtcSessions.channelId, input.channelId))
      .orderBy(desc(schema.rtcRecordings.createdAt))
      .limit(Math.min(input.limit ?? MAX_RECORDINGS_PAGE, MAX_RECORDINGS_PAGE));
  });
}

/**
 * A presigned GET for a stored recording — how a call's attendees actually
 * get it (§3.9's own deferred question, closed here).
 *
 * ## Who may download: the same line every other recording route draws
 *
 * `channel:read` on the call's channel, not "was this person a joined
 * participant". `recordingStatus` already shows the full consent checklist to
 * anyone who can read the conversation; a download link follows that same
 * line rather than inventing a second, stricter one nothing else here draws.
 * A participant who left mid-call and a member who joined the channel
 * afterward see the same recording a moderator reviewing the conversation
 * would — which is the correct scope for a conversation's own recorded
 * artifact, exactly as `chat.attachments.download` treats a shared file.
 *
 * ## The channel check runs INLINE, not through `authorizedSession`
 *
 * That helper opens its own transaction. Nesting one inside the transaction
 * below would mean the audit write a few lines down is not provably in the
 * same snapshot as the read that authorized it — so this repeats the two-line
 * body instead, the same trade `presignRecordingUpload` makes for the same
 * reason.
 */
export async function presignRecordingDownload(
  actor: RtcActor,
  deps: RtcDeps,
  input: { readonly recordingId: string },
): Promise<{ readonly url: string; readonly expiresInSeconds: number }> {
  if (deps.storage === undefined) {
    throw errors.serviceUnavailable('Call recording storage is not configured on this instance.');
  }

  /* Sixty seconds, matching attachments and telephony recordings — the window
     is the blast radius of a leaked link, not a UX choice. */
  const expiresInSeconds = 60;
  const orgId = orgOf(actor);

  const row = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.rtcRecordings.id,
        sessionId: schema.rtcRecordings.sessionId,
        status: schema.rtcRecordings.status,
        storageKey: schema.rtcRecordings.storageKey,
      })
      .from(schema.rtcRecordings)
      .where(eq(schema.rtcRecordings.id, input.recordingId))
      .limit(1);

    const recording = rows[0];
    if (recording === undefined) throw errors.notFound();

    /* THE invariant, restated from `presignRecordingUpload`'s own: anything
       not `stored` has either not finished landing or never will, and there
       is nothing to hand out either way. 404 rather than a status-specific
       message — the caller does not need to learn which. */
    if (recording.status !== 'stored') throw errors.notFound();

    const session = await loadSession(tx, recording.sessionId);
    const channel = await loadChannel(tx, session.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:read', channel);

    /* Written BEFORE the URL is issued, in the same transaction as the read
       that authorized it — `telephony/recording.service.ts`'s own reasoning
       for `recordingDownloaded`: a crash between the two would produce a
       downloadable URL with no record that anyone asked for it, and "who
       took a copy" is the question this event exists to answer. */
    await outboxWriter.append(tx, [
      createEvent(
        rtcRecordingDownloaded,
        { sessionId: recording.sessionId, recordingId: recording.id },
        envelopeOf(actor),
      ),
    ]);

    return { storageKey: recording.storageKey };
  });

  const url = await deps.storage.presignDownload(row.storageKey, expiresInSeconds);
  return { url, expiresInSeconds };
}
