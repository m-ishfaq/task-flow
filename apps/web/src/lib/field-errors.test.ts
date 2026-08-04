import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import { fieldError, fieldErrors } from './field-errors.js';

/**
 * Recovering the server's per-field reasons from a client error.
 *
 * The failure this guards against is silent and was live until a real
 * registration hit it: the API knew the password was too short and said so, and
 * the form rendered "The request was not valid." Nothing threw. The reason
 * existed at every layer and was dropped at the last one.
 *
 * The shapes below are what the API's `errorFormatter` actually produces — the
 * domain code and `details` in `data`, the message at the top level — so a
 * change to that contract fails here rather than in a form.
 */

function clientError(
  data: unknown,
  message = 'The request was not valid.',
): TRPCClientError<never> {
  const error = new TRPCClientError(message);
  // `data` is assigned by the client's response parser, not the constructor.
  Object.assign(error, { data });
  return error;
}

describe('fieldErrors', () => {
  it('reads the per-field reasons the API sent', () => {
    const error = clientError({
      code: 'VALIDATION_FAILED',
      requestId: '019fadbd-7077-77fe-b553-17b4f236cbfa',
      details: { password: 'String must contain at least 12 character(s)' },
    });

    expect(fieldErrors(error)).toEqual([
      ['password', 'String must contain at least 12 character(s)'],
    ]);
    expect(fieldError(error, 'password')).toContain('12');
  });

  it('returns nothing for a failure that named no field', () => {
    // FORBIDDEN, NOT_FOUND, a rate limit — the caller falls back to the general
    // message rather than rendering an empty list under the form.
    const error = clientError({ code: 'FORBIDDEN', requestId: 'r1' });

    expect(fieldErrors(error)).toEqual([]);
    expect(fieldError(error, 'password')).toBeUndefined();
  });

  it('returns nothing for a failure the server never explained', () => {
    // A dropped connection or a proxy's HTML error page. Must not throw.
    expect(fieldErrors(new Error('network'))).toEqual([]);
    expect(fieldErrors(null)).toEqual([]);
    expect(fieldErrors(clientError(undefined))).toEqual([]);
  });

  it('ignores a non-string detail rather than rendering [object Object]', () => {
    /* `details` is `Record<string, unknown>` on the wire — the schema permits
       structured values, and a form can only render text. */
    const error = clientError({
      code: 'VALIDATION_FAILED',
      requestId: 'r1',
      details: { password: 'too short', meta: { nested: true }, count: 3 },
    });

    expect(fieldErrors(error)).toEqual([['password', 'too short']]);
  });

  it('surfaces a whole-body rejection under the `_` key', () => {
    // What the API emits when the payload was not an object at all, so Zod's
    // issue carries no path.
    const error = clientError({
      code: 'VALIDATION_FAILED',
      requestId: 'r1',
      details: { _: 'Expected object, received string' },
    });

    expect(fieldError(error, '_')).toBe('Expected object, received string');
  });
});
