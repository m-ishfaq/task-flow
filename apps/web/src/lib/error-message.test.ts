import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { FALLBACK, humanizeSeconds, messageFor } from './error-message.js';

/**
 * The sentence a user actually reads.
 *
 * The case that motivated this file: a real 429 reached the browser and showed
 * "Something went wrong, and the server did not say what." The server HAD said
 * what — including how long to wait — but the rate limiter answered `/trpc` in
 * the REST envelope, which the tRPC client cannot parse, so `error.data` was
 * undefined and every reader fell through to the fallback.
 *
 * The server half is fixed and pinned in `apps/api/src/middleware/rate-limit.test.ts`.
 * This is the half that turns it into words.
 */

function clientError(data: unknown, message = 'Too many requests. Please slow down.') {
  const error = new TRPCClientError(message);
  // `data` is populated by the client's response parser, not the constructor.
  Object.assign(error, { data });
  return error;
}

describe('messageFor', () => {
  it('includes the wait the server supplied', () => {
    /* The exact shape the rate limiter now emits for a /trpc route — pinned on
       the server side by rate-limit.test.ts. */
    const error = clientError({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      requestId: '019fadec-b8c1-727b-b9d8-01e8accd0fd3',
      retryAfterSeconds: 601,
    });

    expect(messageFor(error)).toBe('Too many attempts. You can try again in about 11 minutes.');
  });

  it('prefers our wording over a terse server message', () => {
    const error = clientError({ code: 'FORBIDDEN', requestId: 'r1' }, 'Forbidden');
    expect(messageFor(error)).toBe('You do not have permission to do that.');
  });

  it("uses the server's own message for codes we have no wording for", () => {
    // The server knows what was being attempted; a generic sentence would be
    // strictly less useful.
    const error = clientError({ code: 'ALREADY_EXISTS', requestId: 'r1' }, 'That key is taken.');
    expect(messageFor(error)).toBe('That key is taken.');
  });

  it('falls back only when the server explained nothing', () => {
    // A dropped connection, a proxy's HTML page — genuinely unreadable.
    expect(messageFor(new Error('network'))).toBe(FALLBACK);
    expect(messageFor(clientError(undefined))).toBe(FALLBACK);
  });
});

describe('humanizeSeconds', () => {
  it('rounds up, never down', () => {
    /* Rounding 90 seconds down to "1 minute" invites a retry that is still
       refused — and on a sliding window each refused retry pushes the window
       out, so the friendlier number is what keeps someone locked out. */
    expect(humanizeSeconds(90)).toBe('2 minutes');
    expect(humanizeSeconds(61)).toBe('2 minutes');
    expect(humanizeSeconds(3601)).toBe('2 hours');
  });

  it('uses seconds below a minute', () => {
    expect(humanizeSeconds(30)).toBe('30 seconds');
    expect(humanizeSeconds(59)).toBe('59 seconds');
  });

  it('agrees with itself about singulars', () => {
    expect(humanizeSeconds(60)).toBe('1 minute');
    expect(humanizeSeconds(3600)).toBe('1 hour');
  });
});
