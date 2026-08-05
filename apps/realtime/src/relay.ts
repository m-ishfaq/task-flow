import {
  claimPending,
  listenForOutboxAppends,
  markDispatched,
  recordFailure,
  withRealtimeScope,
  type OutboxListener,
  type OutboxRow,
} from '@taskflow/db';
import type { Logger } from '@taskflow/observability';

/**
 * The realtime consumer's drain loop (§3.5, §7.3).
 *
 * ## Its own copy of the audit relay's shape, on purpose
 *
 * `apps/api/src/tenancy/relay.ts` is the direct template and this does not
 * import it. §3.5 argues the duplication: the two diverge the moment realtime
 * needs backpressure that audit must never have. A slow client is a reason to
 * shed a broadcast; a slow audit write is never a reason to drop an audit entry.
 * Sharing one loop would mean the next person tuning this one has to reason
 * about whether their change is safe for the compliance record.
 *
 * ## At-least-once, unlike audit — and why that is not a downgrade
 *
 * The audit projection claims, writes, and marks in ONE transaction, so it is
 * exactly-once. This one cannot be: a broadcast is a side effect on a network
 * socket, and no transaction rolls that back. So the order is claim → broadcast
 * → mark, and a process that dies between the last two redelivers on the next
 * tick.
 *
 * That is the ordinary outbox contract, and it is the right way round. The
 * alternative — mark first, then broadcast — loses the event permanently in the
 * same crash. A duplicate broadcast is absorbed by the client: it drops echoes
 * of its own `mutationId` (§3.6), and every handler applies a state patch rather
 * than an increment, so applying one twice lands in the same place.
 *
 * ## Two wake-ups, and only one of them is load-bearing
 *
 * The poll is the correctness guarantee; `LISTEN` only makes the common case
 * fast (§7.3). If the notification channel silently died, this would still
 * deliver every event, just one poll interval later. If the poll were removed,
 * a listener that dropped for two seconds would lose everything sent in that
 * window with no gap to detect. The asymmetry is why both exist and why the poll
 * interval is free to stay lazy.
 */

/** How many events one claim takes. */
const BATCH_SIZE = 100;

/**
 * The consumer name. Must match migration 0016's `WITH CHECK (consumer =
 * 'realtime')` — the database refuses any other value from this role, which is
 * the point: a typo here fails loudly instead of silently marking an event
 * dispatched to `audit` and erasing it from the compliance relay's queue.
 */
export const CONSUMER = 'realtime';

/**
 * Handles one claimed event. Returning normally means "delivered"; throwing
 * means "leave it claimable and count the attempt".
 */
export type Dispatch = (row: OutboxRow) => void | Promise<void>;

export interface RelayHandle {
  stop: () => Promise<void>;
  /** Runs one drain immediately. Exposed for tests, which must not sleep. */
  drainNow: () => Promise<number>;
}

export interface StartRelayOptions {
  readonly logger: Logger;
  readonly dispatch: Dispatch;
  readonly pollIntervalMs: number;
}

export function startRealtimeRelay(options: StartRelayOptions): RelayHandle {
  let running = false;
  let stopped = false;
  let listener: OutboxListener | undefined;

  /**
   * Claims and dispatches one batch.
   *
   * The claim's `FOR UPDATE ... SKIP LOCKED` is what lets a second gateway
   * instance run without coordination — each claims a disjoint set rather than
   * both blocking on the same head row. Two DIFFERENT consumers were never
   * contending here at all: realtime's and audit's dispatch rows are different
   * rows by construction (migration 0015).
   */
  const drainOnce = async (): Promise<number> => {
    return withRealtimeScope(async (tx) => {
      const rows = await claimPending(tx, CONSUMER, BATCH_SIZE);
      if (rows.length === 0) return 0;

      const delivered: string[] = [];

      for (const row of rows) {
        try {
          await options.dispatch(row);
          delivered.push(row.id);
        } catch (error) {
          /* One event failing must not abandon the rest of the batch. The
             attempt is counted so a permanently-failing event is visible as a
             growing number rather than as a queue that has silently stopped. */
          await recordFailure(
            tx,
            CONSUMER,
            row.id,
            error instanceof Error ? error.message : String(error),
          );
          options.logger.error(
            { err: error, event: row.name, eventId: row.id },
            'realtime relay failed to dispatch an event',
          );
        }
      }

      await markDispatched(tx, CONSUMER, delivered);
      return delivered.length;
    });
  };

  /** Drains until the queue is empty, so a burst does not wait for later ticks. */
  const drainFully = async (): Promise<number> => {
    let total = 0;
    for (;;) {
      const processed = await drainOnce();
      total += processed;
      if (processed < BATCH_SIZE) return total;
    }
  };

  const tick = async (): Promise<void> => {
    /* Skip rather than queue. A drain that outlasts the interval would otherwise
       overlap with itself — still correct under SKIP LOCKED, but it turns a slow
       database into an unbounded number of concurrent transactions against it,
       which is how a slow database becomes a dead one. */
    if (running || stopped) return;
    running = true;

    try {
      const processed = await drainFully();
      if (processed > 0) {
        options.logger.debug({ processed }, 'realtime relay drained outbox');
      }
    } catch (error) {
      /* Logged, never rethrown. An unhandled rejection inside a timer takes the
         process down, and a transient database blip must not turn into a
         gateway outage — the events are still in the outbox and the next tick
         retries them, which is exactly what the table is for. */
      options.logger.error({ err: error }, 'realtime relay tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, options.pollIntervalMs);
  timer.unref();

  /* The listener is best-effort. A gateway that could not establish it still
     works — at the poll interval — so failing to start is a warning rather than
     a boot failure. Saying so out loud matters: the symptom of a silently absent
     listener is "realtime feels slow", which is the hardest kind of report to
     act on.
     The chain is awaited by `stop()` below rather than fired-and-forgotten:
     `connect()`/`LISTEN` take a real round trip, so a caller invoking
     `stop()` shortly after `startRealtimeRelay()` would otherwise find
     `listener` still `undefined` — `await listener?.stop()` a no-op — and
     return with the underlying `pg.Client` still connected and still
     listening for a beat after `stop()` resolved. That window is exactly
     enough for a stray notification to reach a relay a caller believes is
     already stopped. */
  const listenSetup: Promise<void> = listenForOutboxAppends({
    onAppend: () => {
      void tick();
    },
    onError: (error) => {
      options.logger.warn(
        { err: error },
        'outbox LISTEN connection failed; falling back to the poll interval until it recovers',
      );
    },
  })
    .then(async (handle) => {
      if (stopped) {
        await handle.stop();
        return;
      }
      listener = handle;
    })
    .catch((error: unknown) => {
      options.logger.warn(
        { err: error },
        'could not LISTEN for outbox appends; broadcasts will lag by up to the poll interval',
      );
    });

  return {
    drainNow: drainFully,
    stop: async () => {
      stopped = true;
      /* Ensures the branch above has resolved — either the listener was
         never assigned (and this awaits its own self-stop), or it was
         assigned and the explicit stop just below tears it down. Either
         way, `stop()` resolving means no live LISTEN connection remains. */
      await listenSetup;
      clearInterval(timer);
      await listener?.stop();
    },
  };
}
