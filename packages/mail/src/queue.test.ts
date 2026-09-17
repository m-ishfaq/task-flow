import { describe, expect, it, vi } from 'vitest';
import { MailQueue } from './queue.js';
import { MemoryMailer, type OutboundMessage } from './transport.js';

/**
 * The mail worker (PLAN.md §8.1).
 *
 * The property under test is mostly about TIMING, not delivery: enqueueing must
 * cost the same whether or not there is anything to send, because the caller —
 * `requestPasswordReset` — answers identically for a known and an unknown
 * address and would otherwise leak the difference in its response time.
 */

const MESSAGE: OutboundMessage = {
  to: 'user@example.test',
  subject: 'Confirm your Rinavai email address',
  text: 'link',
  html: '<p>link</p>',
};

/** No real delay, so backoff can be exercised without waiting for it. */
const instant = (): Promise<void> => Promise.resolve();

describe('delivery', () => {
  it('sends what is queued', async () => {
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('user@example.test');
  });

  it('preserves order', async () => {
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    for (const n of [1, 2, 3]) queue.enqueue({ ...MESSAGE, subject: `m${String(n)}` });
    await queue.drain();

    expect(mailer.sent.map((message) => message.subject)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns from enqueue before anything is sent', () => {
    /* The timing property. If enqueue awaited delivery, requestPasswordReset
       would take measurably longer for an address that exists than for one that
       does not — a free account-existence oracle behind an endpoint whose entire
       design is to answer identically either way. */
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    queue.enqueue(MESSAGE);

    expect(mailer.sent).toHaveLength(0);
    expect(queue.depth).toBe(1);
  });
});

describe('retries', () => {
  it('retries a failed send', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext(2);
    const queue = new MailQueue({ mailer, sleep: instant });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(1);
    expect(queue.abandoned).toBe(0);
  });

  it('gives up after the attempt budget', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext(100);
    const queue = new MailQueue({ mailer, maxAttempts: 3, sleep: instant });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(0);
    expect(queue.abandoned).toBe(1);
  });

  it('reports an abandoned message without its body', async () => {
    /* The only record that a user never got their link — and it must not BE the
       link. A body in a log file is a credential in a log file, readable by
       anyone with log access and retained long past the token's lifetime. */
    const mailer = new MemoryMailer();
    mailer.failNext(100);

    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const queue = new MailQueue({
      mailer,
      maxAttempts: 2,
      sleep: instant,
      onFailure: (failure) => failures.push(failure),
    });

    queue.enqueue({ ...MESSAGE, text: 'https://app/verify?token=SECRET' });
    await queue.drain();

    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain('SECRET');
    expect(failures[0]?.to).toBe('user@example.test');
  });

  it('reports the transport failure reason, so a real cause is diagnosable', async () => {
    /* Before this, the queue's catch block discarded whatever the transport
       threw — "mail delivery abandoned" was the entire incident record, with
       no way to tell an auth failure from a blocked port from a timeout
       without reproducing the failure by hand. */
    const mailer = new MemoryMailer();
    mailer.failNext(100);

    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const queue = new MailQueue({
      mailer,
      maxAttempts: 2,
      sleep: instant,
      onFailure: (failure) => failures.push(failure),
    });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('simulated transport failure');
  });

  it('reports a reason when the queue itself is full, not just when sending fails', () => {
    const mailer = new MemoryMailer();
    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const queue = new MailQueue({
      mailer,
      sleep: instant,
      onFailure: (failure) => failures.push(failure),
    });

    // Fill the queue past capacity without draining it, so the next enqueue
    // hits the MAX_QUEUED guard rather than a transport failure.
    for (let index = 0; index < 10_001; index += 1) queue.enqueue(MESSAGE);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.attempts).toBe(0);
    expect(failures[0]?.reason).toContain('queue full');
  });

  it('keeps going after abandoning one message', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext(2);
    const queue = new MailQueue({ mailer, maxAttempts: 2, sleep: instant });

    queue.enqueue({ ...MESSAGE, subject: 'doomed' });
    queue.enqueue({ ...MESSAGE, subject: 'fine' });
    await queue.drain();

    expect(mailer.sent.map((message) => message.subject)).toEqual(['fine']);
    expect(queue.abandoned).toBe(1);
  });

  it('abandons a permanent SMTP rejection without retrying', async () => {
    /* A 550 is the server saying "this will never work" — Gmail's own
       "550 5.4.5 Daily user sending limit exceeded" is the motivating case.
       Retrying it burns the full attempt budget (and its backoff delay) on a
       message that was refused before the first byte of DATA was even sent,
       and does so identically for every message queued behind it until the
       limit resets. */
    const mailer = new MemoryMailer();
    mailer.failNext(100, () =>
      Object.assign(new Error('Data command failed: 550 5.4.5 Daily user sending limit exceeded'), {
        responseCode: 550,
      }),
    );

    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const queue = new MailQueue({
      mailer,
      maxAttempts: 4,
      sleep: instant,
      onFailure: (failure) => failures.push(failure),
    });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(0);
    expect(queue.abandoned).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.attempts).toBe(1);
  });

  it('still retries a transient (4xx) SMTP failure up to the attempt budget', async () => {
    const mailer = new MemoryMailer();
    mailer.failNext(2, () =>
      Object.assign(new Error('Data command failed: 450 mailbox temporarily unavailable'), {
        responseCode: 450,
      }),
    );
    const queue = new MailQueue({ mailer, maxAttempts: 4, sleep: instant });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(1);
    expect(queue.abandoned).toBe(0);
  });

  it('does not crash the process when the transport is down', async () => {
    // An unhandled rejection from a background task terminates the process in
    // Node 22, which would turn "the mail server is down" into "the API is down".
    const mailer = new MemoryMailer();
    mailer.failNext(100);
    const queue = new MailQueue({ mailer, maxAttempts: 2, sleep: instant });

    expect(() => {
      queue.enqueue(MESSAGE);
    }).not.toThrow();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});

describe('domain check', () => {
  it('abandons a message without ever reaching the transport when the domain check refuses it', async () => {
    const mailer = new MemoryMailer();
    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const checkDomain = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'no MX, A, or AAAA records' });
    const queue = new MailQueue({
      mailer,
      sleep: instant,
      checkDomain,
      onFailure: (failure) => failures.push(failure),
    });

    queue.enqueue({ ...MESSAGE, to: 'user@taskflow.seed.test' });
    await queue.drain();

    expect(mailer.sent).toHaveLength(0);
    expect(queue.abandoned).toBe(1);
    expect(failures).toHaveLength(1);
    // Never attempted, unlike a real SMTP failure — the reported attempts say so.
    expect(failures[0]?.attempts).toBe(0);
    expect(failures[0]?.reason).toContain('no MX, A, or AAAA records');
    expect(checkDomain).toHaveBeenCalledWith('taskflow.seed.test');
  });

  it('sends normally when the domain check accepts the recipient', async () => {
    const mailer = new MemoryMailer();
    const checkDomain = vi.fn().mockResolvedValue({ ok: true, reason: 'has MX records' });
    const queue = new MailQueue({ mailer, sleep: instant, checkDomain });

    queue.enqueue(MESSAGE);
    await queue.drain();

    expect(mailer.sent).toHaveLength(1);
    expect(queue.abandoned).toBe(0);
  });

  it('is skipped entirely when no checkDomain is configured', async () => {
    // The default: existing callers see no behaviour change.
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    queue.enqueue({ ...MESSAGE, to: 'user@taskflow.seed.test' });
    await queue.drain();

    expect(mailer.sent).toHaveLength(1);
  });

  it('refuses a malformed recipient with no domain, without calling checkDomain', async () => {
    const mailer = new MemoryMailer();
    const checkDomain = vi.fn();
    const failures: { to: string; subject: string; attempts: number; reason: string }[] = [];
    const queue = new MailQueue({
      mailer,
      sleep: instant,
      checkDomain,
      onFailure: (failure) => failures.push(failure),
    });

    queue.enqueue({ ...MESSAGE, to: 'not-an-email' });
    await queue.drain();

    expect(mailer.sent).toHaveLength(0);
    expect(checkDomain).not.toHaveBeenCalled();
    expect(failures[0]?.reason).toContain('no domain to check');
  });
});

describe('shutdown', () => {
  it('flushes what is queued before closing', async () => {
    // Otherwise a deploy during a signup silently discards the verification
    // link, and the user is left with an account they cannot reach.
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    queue.enqueue(MESSAGE);
    await queue.close();

    expect(mailer.sent).toHaveLength(1);
  });

  it('ignores anything enqueued after closing', async () => {
    const mailer = new MemoryMailer();
    const queue = new MailQueue({ mailer, sleep: instant });

    await queue.close();
    queue.enqueue(MESSAGE);

    expect(mailer.sent).toHaveLength(0);
  });
});
