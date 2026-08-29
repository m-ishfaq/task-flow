import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { errorMessageOf } from './trpc-client.js';

/**
 * `errorMessageOf` — the offline-aware sibling of `apiErrorOf`/`errorCodeOf`
 * (ai/phase-14-mobile.md's own "offline" gap: every failed mutation showed
 * the same generic "Something went wrong" whether the server explained
 * itself, was unreachable, or the device had no connection at all).
 */

function clientError(data: unknown, message = 'Something failed.') {
  const error = new TRPCClientError(message);
  // `data` is populated by the client's response parser, not the constructor —
  // same construction apps/web's own error-message.test.ts uses.
  Object.assign(error, { data });
  return error;
}

describe('errorMessageOf', () => {
  it("prefers the server's own message, online or offline", () => {
    const error = clientError({ code: 'FORBIDDEN', requestId: 'r1' }, 'Not allowed.');
    expect(errorMessageOf(error, false)).toBe('Not allowed.');
    expect(errorMessageOf(error, true)).toBe('Not allowed.');
  });

  it('names the connection when offline and the server said nothing', () => {
    // A real dropped connection: the request never reached the server, so
    // there is no ApiError to parse.
    expect(errorMessageOf(new Error('Network request failed'), true)).toBe(
      'No internet connection. Check your connection and try again.',
    );
  });

  it('falls back to the generic message when online and the server said nothing', () => {
    // Some other unparseable failure — a 500, a malformed response — with a
    // confirmed connection: the offline message would be actively wrong here.
    expect(errorMessageOf(new Error('boom'), false)).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
