import { api } from '../../lib/trpc.js';

/**
 * Capturing a call, client-side (ai/phase-13-webrtc.md §3.9).
 *
 * ## Why the browser records rather than the server
 *
 * There is no server in the media path. Wave 1 is mesh — audio goes
 * browser-to-browser and never touches this deployment — so the only place
 * every stream exists together is inside one participant's tab. Recording
 * server-side would mean an SFU, which §2 defers as a separate deployable.
 *
 * The consequence, stated plainly because it is a real limitation: the
 * recording is only as complete as the recorder's own connection. If the person
 * capturing loses a peer for ten seconds, those ten seconds of that peer are
 * missing from the file. The database records who consented and when
 * (`rtc.participants`), not that the audio is forensically complete, and
 * nothing in this system claims otherwise.
 *
 * ## Everyone's audio is MIXED, not multiplexed
 *
 * One Web Audio graph sums the local microphone and every remote stream into a
 * single destination, and `MediaRecorder` captures that. Per-peer tracks would
 * be better evidence and would need a container format that carries them, a
 * player that understands it, and a decision about what happens when somebody
 * joins mid-recording. A single mixed track is what a person means by "a
 * recording of the call".
 *
 * ## Sources are added as peers arrive
 *
 * `addStream` is called for every peer, including ones that join after capture
 * starts — which is possible because a join PAUSES recording (migration 0042's
 * consent counter) and it resumes only once they agree. So a stream added
 * mid-capture always belongs to somebody who has consented.
 */

export interface CallRecorder {
  /** Adds a peer's audio to the mix. Safe to call twice for one stream. */
  addStream: (stream: MediaStream) => void;
  /**
   * Stops capture, uploads, and confirms.
   *
   * Resolves once the recording row is `stored`. Rejects if the upload failed —
   * the caller reports it, and the row stays `pending` rather than claiming a
   * recording that is not there.
   */
  finish: () => Promise<void>;
  /** Abandons capture and releases the audio graph. Uploads nothing. */
  cancel: () => void;
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/**
 * The container this browser can actually produce.
 *
 * Chosen by asking rather than assumed: Safari does not support
 * `audio/webm` at all, and a `MediaRecorder` constructed with a MIME type it
 * cannot produce throws — which would surface as "recording is broken on this
 * browser" with no indication of why. The server pins `audio/webm` into the
 * presigned PUT's signature, so a browser that cannot produce it is refused
 * here, before anybody is told recording started.
 */
function supportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : null;
}

export function canRecord(): boolean {
  return supportedMimeType() !== null && audioContextConstructor() !== undefined;
}

export function startCallRecorder(input: {
  readonly recordingId: string;
  readonly localStream: MediaStream;
  readonly remoteStreams: readonly MediaStream[];
}): CallRecorder | null {
  const Constructor = audioContextConstructor();
  const mimeType = supportedMimeType();
  if (Constructor === undefined || mimeType === null) return null;

  const context = new Constructor();
  const destination = context.createMediaStreamDestination();
  const added = new WeakSet<MediaStream>();
  const chunks: Blob[] = [];
  const startedAt = Date.now();

  const addStream = (stream: MediaStream): void => {
    /* A WeakSet rather than an array: connecting one stream twice sums it with
       itself, which is audible as that person being twice as loud as everyone
       else — a defect nobody would think to look for in a graph. */
    if (added.has(stream)) return;
    if (stream.getAudioTracks().length === 0) return;
    added.add(stream);

    const source = context.createMediaStreamSource(stream);
    source.connect(destination);
  };

  addStream(input.localStream);
  for (const stream of input.remoteStreams) addStream(stream);

  const recorder = new MediaRecorder(destination.stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  /* A timeslice, so data arrives in chunks rather than as one blob at stop.
     Without it a long call holds the entire recording in one un-flushed
     internal buffer, and a tab that crashes loses all of it — with it, the
     loss is bounded by the slice. */
  recorder.start(5_000);

  const release = (): void => {
    if (recorder.state !== 'inactive') recorder.stop();
    void context.close().catch(() => undefined);
  };

  return {
    addStream,

    finish: async () => {
      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType }));
        };
        if (recorder.state === 'inactive') {
          resolve(new Blob(chunks, { type: mimeType }));
        } else {
          recorder.stop();
        }
      });

      void context.close().catch(() => undefined);

      if (blob.size === 0) {
        throw new Error('The recording was empty and was not uploaded.');
      }

      /* `bytes` travels WITH the request, not after it. The recording's real
         size is only known now — capture just stopped — and the server pins
         exactly this number into the PUT's signature (`recording.service.ts`'s
         own header on why: a signature pinned to the deployment's ceiling
         instead matches almost no real upload, since a browser's `fetch()`
         always sends the body's ACTUAL byte count as `Content-Length` and
         cannot be told to send anything else). Oversized is refused HERE, by
         the mutation itself, with a message naming the limit — the
         alternative is an opaque 403 from storage that nothing can explain. */
      const presigned = await api.rtc.recording.presignUpload.mutate({
        recordingId: input.recordingId,
        bytes: blob.size,
      });

      const response = await fetch(presigned.url, {
        method: 'PUT',
        /* The headers the signature covers. Sending a different content type
           makes storage reject it — which is the guarantee working, and the
           reason `presignUpload` returns them rather than letting this file
           guess. */
        headers: { ...presigned.headers },
        body: blob,
      });

      if (!response.ok) {
        throw new Error(`The recording could not be uploaded (${String(response.status)}).`);
      }

      await api.rtc.recording.confirmUpload.mutate({
        recordingId: input.recordingId,
        bytes: blob.size,
        durationSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      });
    },

    cancel: release,
  };
}
