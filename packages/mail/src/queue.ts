import type { Mailer, OutboundMessage } from './transport.js';

/**
 * The mail worker (PLAN.md §8.1).
 *
 * ## Why enqueue rather than send inline
 *
 * Two reasons, and the second is the one that matters.
 *
 * The obvious one is latency: registration should not wait on SMTP.
 *
 * The real one is a **timing oracle**. `requestPasswordReset` answers "sent"
 * whether or not the address has an account — that is the whole design, so the
 * endpoint cannot be used to enumerate customers. But the known-address path
 * sends mail and the unknown-address path does not, so if sending is inline the
 * two answers differ by however long SMTP takes. A few hundred milliseconds is a
 * completely reliable remote oracle, and it defeats a defence that reads as
 * correct in the source. Enqueueing makes both paths return in the same time,
 * because neither waits for anything.
 *
 * That is not a hypothetical: this queue was written after noticing that
 * replacing the dev-mode `console.warn` with a real transport would have
 * introduced exactly that oracle into code that had been reviewed as safe.
 *
 * ## What this is NOT
 *
 * In-process and in-memory. A crash loses whatever is queued, which for a
 * verification link means the user waits and clicks "resend". The durable
 * version is the transactional outbox in @taskflow/events driven by a real
 * worker process (§4) — this is the Phase 1 shape, and the interface does not
 * change when that arrives.
 */

export interface MailQueueOptions {
  readonly mailer: Mailer;
  /** Attempts per message, including the first. */
  readonly maxAttempts?: number;
  /** First retry delay; each subsequent one multiplies by `backoffFactor`. */
  readonly baseDelayMs?: number;
  readonly backoffFactor?: number;
  /**
   * Called when a message is abandoned.
   *
   * Takes the message KIND and recipient, never the body — a queue that logs a
   * failed verification mail in full writes the credential it was carrying into
   * the log file.
   */
  readonly onFailure?: (failure: { to: string; subject: string; attempts: number }) => void;
  /**
   * Called when a message sends successfully — the same shape as `onFailure`,
   * for the same redaction reason. Optional and separate rather than folded
   * into `onFailure` with a boolean flag: most callers (this package's own
   * tests) care only about failure, and a required callback that most code
   * ignores is a callback most code gets slightly wrong.
   */
  readonly onSuccess?: (success: { to: string; subject: string }) => void;
  /** Injected for tests. Real code has no reason to pass this. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_BACKOFF_FACTOR = 4;

/**
 * Ceiling on queued messages.
 *
 * Every message here was created by a request, and the endpoints that create
 * them are rate limited (§8.9) — but a limiter is a per-caller control and this
 * is a whole-process resource. Dropping the NEWEST message when full is the
 * right direction: the ones already queued are older, closer to being sent, and
 * belong to users who have been waiting longer.
 */
const MAX_QUEUED = 10_000;

interface QueueEntry {
  readonly message: OutboundMessage;
  attempts: number;
}

export class MailQueue {
  readonly #mailer: Mailer;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #backoffFactor: number;
  readonly #onFailure: (failure: { to: string; subject: string; attempts: number }) => void;
  readonly #onSuccess: (success: { to: string; subject: string }) => void;
  readonly #sleep: (ms: number) => Promise<void>;

  readonly #pending: QueueEntry[] = [];
  #running: Promise<void> | null = null;
  #closed = false;

  /** Messages abandoned after every attempt failed. Observable for tests and health. */
  #abandoned = 0;

  constructor(options: MailQueueOptions) {
    this.#mailer = options.mailer;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.#backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    this.#onFailure = options.onFailure ?? (() => undefined);
    this.#onSuccess = options.onSuccess ?? (() => undefined);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get depth(): number {
    return this.#pending.length;
  }

  get abandoned(): number {
    return this.#abandoned;
  }

  /**
   * Accepts a message and returns immediately.
   *
   * Constant time, and deliberately so — see the timing-oracle note above. It
   * returns void rather than a promise for the same reason: a caller cannot
   * accidentally await delivery and reintroduce the coupling.
   */
  enqueue(message: OutboundMessage): void {
    if (this.#closed) return;

    if (this.#pending.length >= MAX_QUEUED) {
      this.#abandoned += 1;
      this.#onFailure({ to: message.to, subject: message.subject, attempts: 0 });
      return;
    }

    this.#pending.push({ message, attempts: 0 });
    this.#pump();
  }

  /**
   * Waits for the queue to empty.
   *
   * For graceful shutdown and for tests. Not for request handlers: awaiting this
   * inside one puts the timing oracle straight back.
   */
  async drain(): Promise<void> {
    while (this.#running !== null || this.#pending.length > 0) {
      await (this.#running ?? Promise.resolve());
      if (this.#running === null && this.#pending.length > 0) this.#pump();
    }
  }

  /** Stops accepting work, finishes what is queued, then closes the transport. */
  async close(): Promise<void> {
    await this.drain();
    this.#closed = true;
    await this.#mailer.close();
  }

  #pump(): void {
    if (this.#running !== null) return;

    /* `#run()` starts on a microtask, not inline.
     *
     * Calling it directly would execute its body synchronously up to the first
     * genuine await — which means the cost of `enqueue` depends on how much work
     * the transport does before ITS first await. That is the timing oracle
     * coming back through a side door: a mailer that resolved DNS or opened a
     * socket synchronously would make `requestPasswordReset` measurably slower
     * for an address that exists. Deferring makes the guarantee a property of
     * this queue rather than a property of whichever transport is installed.
     *
     * `#running` is still assigned synchronously, so `drain` sees the work. */
    this.#running = Promise.resolve()
      .then(() => this.#run())
      .finally(() => {
        this.#running = null;
      });

    /* Nothing awaits the pump — that is the point. The rejection handler is here
       because an unhandled rejection from a background task terminates the
       process in Node 22, which would turn "the mail server is down" into "the
       API is down". */
    this.#running.catch(() => undefined);
  }

  async #run(): Promise<void> {
    while (this.#pending.length > 0) {
      const entry = this.#pending[0];
      if (entry === undefined) break;

      try {
        await this.#mailer.send(entry.message);
        this.#pending.shift();
        this.#onSuccess({ to: entry.message.to, subject: entry.message.subject });
        continue;
      } catch {
        entry.attempts += 1;
      }

      if (entry.attempts >= this.#maxAttempts) {
        this.#pending.shift();
        this.#abandoned += 1;
        /* The recipient and subject only. The body holds the link, and a link in
           a log file is a credential in a log file — readable by anyone with log
           access, and retained far longer than the token's own lifetime. */
        this.#onFailure({
          to: entry.message.to,
          subject: entry.message.subject,
          attempts: entry.attempts,
        });
        continue;
      }

      /* Head-of-line blocking is intentional. A transport failure is almost
         always the SERVER being unreachable rather than one bad message, so
         racing ahead to the next message just fails it too — and burns its
         attempts against an outage it had nothing to do with. */
      await this.#sleep(this.#baseDelayMs * this.#backoffFactor ** (entry.attempts - 1));
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Retrying mail must not hold a shutting-down process open.
    timer.unref();
  });
}
