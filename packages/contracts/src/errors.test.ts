import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  AppError,
  ERROR_CODES,
  ERROR_STATUS,
  errors,
  isAppError,
} from './errors.js';

describe('AppError', () => {
  it('serializes to the wire contract', () => {
    const error = errors.notFound('Card not found.');
    const response = error.toResponse('req_123');

    expect(ApiErrorSchema.parse(response)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Card not found.', requestId: 'req_123' },
    });
  });

  it('omits optional fields rather than emitting undefined', () => {
    // `exactOptionalPropertyTypes` is on, and an explicit `details: undefined`
    // serializes to a key with a null value in some encoders. Omission is the
    // contract.
    const response = errors.forbidden().toResponse('req_1');
    expect('details' in response.error).toBe(false);
    expect('retryAfterSeconds' in response.error).toBe(false);
  });

  it('carries retryAfterSeconds on rate limiting', () => {
    const response = errors.rateLimited(30).toResponse('req_1');
    expect(response.error.retryAfterSeconds).toBe(30);
    expect(response.error.code).toBe('RATE_LIMITED');
  });

  it('preserves the cause without exposing it in the response', () => {
    const cause = new Error('connection refused: postgres://user:pw@10.0.0.5');
    const error = errors.internal(cause);
    const response = error.toResponse('req_1');

    expect(error.cause).toBe(cause);
    // The internal detail must not reach the client (§8.7).
    expect(response.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(response)).not.toContain('postgres://');
  });

  it('is recognizable via isAppError', () => {
    expect(isAppError(errors.forbidden())).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('error code contract', () => {
  it('maps every code to an HTTP status', () => {
    // A code with no status would fall through to `undefined` and produce a
    // broken response at the worst possible moment.
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code], `${code} has no status`).toBeTypeOf('number');
    }
  });

  it('uses NOT_FOUND rather than FORBIDDEN for invisible resources', () => {
    // Documents a deliberate decision (§8.7): distinguishing "does not exist"
    // from "exists but you cannot see it" confirms the existence of other
    // tenants' data. Both cases return 404.
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(errors.notFound().code).toBe('NOT_FOUND');
  });

  it('keeps authentication and authorization statuses distinct', () => {
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401); // who are you?
    expect(ERROR_STATUS.FORBIDDEN).toBe(403); // I know who you are; no.
    expect(ERROR_STATUS.STEP_UP_REQUIRED).toBe(401); // re-prove it
  });

  it('rejects a response with an unknown code', () => {
    const bad = { error: { code: 'MADE_UP', message: 'x', requestId: 'r' } };
    expect(() => ApiErrorSchema.parse(bad)).toThrow();
  });
});

describe('AppError construction', () => {
  it('derives status from code', () => {
    expect(new AppError('CONFLICT', 'stale').status).toBe(409);
    expect(new AppError('QUOTA_EXCEEDED', 'spend cap').status).toBe(429);
  });

  it('attaches validation details', () => {
    const error = errors.validation({ title: 'required' });
    expect(error.toResponse('r').error.details).toEqual({ title: 'required' });
  });
});
