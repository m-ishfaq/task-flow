import type { StorageProvider } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { ingestPendingRecordings } from './recording-ingest.js';

/**
 * The recording-ingest timer (ai/phase-7-voice.md §7.1, resolved at Wave 2).
 *
 * A timer inside `apps/api`, matching the outbox relay, the backlinks relay,
 * the chat retention sweep and the due-reminder sweep — four existing
 * precedents, each of which notes it "belongs in `apps/worker` on pg-boss".
 * This one carries the same caveat, and §7.1's re-asked decision at Wave 2 was
 * to defer that deployable rather than stand it up for a single consumer.
 *
 * Off by default, and exactly one instance should enable it. The claim is a
 * conditional UPDATE on `attempts` (see `recording-ingest.ts` for why it cannot
 * be `FOR UPDATE SKIP LOCKED` against a column-level grant), so two instances
 * running it are safe — they just waste carrier bandwidth racing for the same
 * rows.
 */

/** How often to look. Recordings are not latency-sensitive; the audio is not going anywhere. */
const INTERVAL_MS = 30_000;

export interface IngestSchedulerOptions {
  readonly logger: Logger;
  readonly storage: StorageProvider;
  readonly fetchRecording: (url: string) => Promise<Uint8Array>;
  readonly intervalMs?: number;
}

export interface IngestScheduler {
  stop: () => void;
}

export function startRecordingIngest(options: IngestSchedulerOptions): IngestScheduler {
  let running = false;

  const tick = async (): Promise<void> => {
    /* Overlap guard. A tick that runs long — a slow carrier, a big batch —
       must not have the next one start alongside it, or two passes race for the
       same rows and one wastes a full download. */
    if (running) return;
    running = true;

    try {
      const result = await ingestPendingRecordings({
        storage: options.storage,
        fetchRecording: options.fetchRecording,
      });

      if (result.stored > 0 || result.failed > 0) {
        options.logger.info(
          { stored: result.stored, failed: result.failed },
          'recording ingest pass',
        );
      }
    } catch (error) {
      /* Never let a tick reject. An unhandled rejection from a timer takes the
         process down, and this sweep failing is not a reason to stop serving
         requests — the recordings stay `pending` and the next tick retries. */
      options.logger.error({ err: error }, 'recording ingest failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? INTERVAL_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * Fetches recording bytes from the carrier over HTTP Basic auth.
 *
 * The ONE place this process reads from a provider-supplied URL, which is why
 * it is a named function rather than an inline `fetch`. Two bounds on it:
 *
 *   - The URL must be on the carrier's own host. A `RecordingUrl` is a value
 *     from a webhook body — signature-verified, so not attacker-controlled in
 *     practice, but "the signature proves the carrier sent it" is not the same
 *     as "the carrier will never send a URL pointing somewhere else". Without
 *     this check the sweep is an SSRF primitive that fetches whatever a
 *     compromised carrier account names.
 *   - A size ceiling, so one enormous response cannot exhaust memory.
 */
export function createCarrierFetch(options: {
  readonly accountSid: string;
  readonly authToken: string;
  readonly allowedHostSuffix?: string;
  readonly maxBytes?: number;
}): (url: string) => Promise<Uint8Array> {
  const allowedSuffix = options.allowedHostSuffix ?? '.twilio.com';
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;

  return async (url: string): Promise<Uint8Array> => {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') {
      throw new Error('Recording URL must be https.');
    }
    if (!parsed.hostname.endsWith(allowedSuffix)) {
      /* The hostname, not the full URL, in the message — the URL is a link to a
         third party's copy of a private conversation and this string reaches a
         `last_error` column a support view will render. */
      throw new Error(`Recording URL host ${parsed.hostname} is not the carrier.`);
    }

    const authorization = `Basic ${Buffer.from(
      `${options.accountSid}:${options.authToken}`,
      'utf8',
    ).toString('base64')}`;

    const response = await fetch(url, { headers: { Authorization: authorization } });
    if (!response.ok) {
      throw new Error(`Carrier returned ${String(response.status)} for the recording.`);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error('Recording exceeds the maximum ingest size.');
    }

    return buffer;
  };
}
