import pg from 'pg';
import { realtimeConnectionString } from './client.js';

/**
 * The outbox wake-up channel (ai/phase-4-realtime.md §7.3).
 *
 * Migration 0016 puts an `AFTER INSERT ... FOR EACH STATEMENT` trigger on
 * `platform.outbox` that issues `pg_notify('outbox_appended', '')`. This is the
 * listening half.
 *
 * ## What this is not
 *
 * It is not a delivery mechanism, and every design choice here follows from
 * that. `NOTIFY` is fire-and-forget: nothing queues it for a listener that is
 * disconnected, and a listener whose connection drops misses every notification
 * sent while it was away — with no gap to detect afterwards. A gateway that
 * woke ONLY on notification would lose events precisely when it had just
 * recovered from a problem, which is the worst possible time.
 *
 * So the relay's poll loop stays, and stays the correctness guarantee. This
 * only makes the common case fast. Concretely: if this module were deleted, the
 * gateway would still deliver every event, just up to one poll interval later.
 * If the poll were deleted instead, the gateway would silently drop events. The
 * asymmetry is the reason both exist.
 *
 * The notification carries no payload. A listener may conclude exactly one
 * thing from it — "drain now" — and re-reads the queue under RLS like any other
 * drain. See 0016 for why a payload here would be a trap.
 *
 * ## Why a dedicated client
 *
 * A `LISTEN` registered on a POOLED connection lasts until that connection is
 * returned to the pool, and then silently does nothing. The failure mode is a
 * gateway that appears healthy, logs nothing, and has quietly degraded to the
 * poll interval — which looks exactly like the notification channel working
 * badly rather than not at all. One long-lived `pg.Client`, owned here,
 * removes the possibility.
 */

const { Client } = pg;

/** Matches the channel name in migration 0016. */
const CHANNEL = 'outbox_appended';

/**
 * How long to wait before rebuilding a listener whose connection died.
 *
 * Bounded and short. The poll loop is already covering the gap, so this is
 * about restoring low latency, not about restoring delivery — which is why it
 * is a flat delay rather than an exponential backoff that could leave the
 * channel down for minutes after a brief blip.
 */
const RECONNECT_DELAY_MS = 2_000;

export interface OutboxListener {
  /** Stops listening and closes the connection. Idempotent. */
  stop: () => Promise<void>;
}

export interface ListenOptions {
  /**
   * Called on every notification. Must not throw — this runs on the pg client's
   * event emitter, where a rejection has no caller to surface to.
   */
  readonly onAppend: () => void;
  /** Called when the listening connection fails. Diagnostic only. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Listens for outbox appends until stopped.
 *
 * Throws if the realtime pool has not been initialized — the same fail-loud
 * choice `withRealtimeScope` makes, and for the same reason: a listener that
 * silently did nothing would leave the gateway on its poll interval with no
 * indication that it had.
 *
 * Reconnects on failure rather than surfacing it, because the caller has no
 * better response available than "try again" and the poll loop has already made
 * the failure non-fatal.
 */
export async function listenForOutboxAppends(options: ListenOptions): Promise<OutboxListener> {
  const url = realtimeConnectionString();
  if (url === undefined) {
    throw new Error(
      'Realtime database not initialized. Call initializeRealtimeDatabase() during boot.',
    );
  }

  let stopped = false;
  let client: pg.Client | undefined;
  let retry: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;

    const next = new Client({
      connectionString: url,
      application_name: 'taskflow-realtime-listen',
    });

    /* Registered BEFORE connect(). An error arriving on a client with no
       'error' handler is an unhandled 'error' event, which takes the process
       down — and a database blip must not be able to kill the gateway when the
       poll loop is already covering for it. */
    next.on('error', (error) => {
      options.onError?.(error);
      void rebuild();
    });

    next.on('notification', (message) => {
      if (message.channel === CHANNEL) options.onAppend();
    });

    await next.connect();
    if (stopped) {
      await next.end();
      return;
    }

    /* Not parameterized, and it cannot be: LISTEN takes an identifier, not a
       value, so there is no placeholder form of this statement. CHANNEL is a
       module-level literal that no caller can influence — the same reasoning
       that makes the field table in packages/filter a security control. */
    await next.query(`LISTEN ${CHANNEL}`);
    client = next;
  };

  const rebuild = async (): Promise<void> => {
    if (stopped || retry !== undefined) return;

    const dying = client;
    client = undefined;
    /* end() on an already-broken connection rejects; there is nothing useful to
       do with that, and letting it escape would replace a recoverable blip with
       an unhandled rejection. */
    await dying?.end().catch(() => undefined);

    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch((error: unknown) => {
        options.onError?.(error);
        void rebuild();
      });
    }, RECONNECT_DELAY_MS);
    retry.unref();
  };

  await connect();

  return {
    stop: async () => {
      stopped = true;
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      const dying = client;
      client = undefined;
      await dying?.end().catch(() => undefined);
    },
  };
}
