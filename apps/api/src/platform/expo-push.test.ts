import { describe, expect, it } from 'vitest';
import { isValidExpoPushToken } from './expo-push.js';

/**
 * `isValidExpoPushToken` — the one piece of `expo-push.ts` that needs no
 * database to test. Registration itself (`registerExpoPushToken` and its
 * siblings) is RLS-scoped `withUserScope` reads/writes, the same shape
 * `push.ts`'s own subscription functions have, and that file carries no
 * dedicated test either — real coverage for that half lives against a real
 * Postgres instance, which this sandbox does not have.
 */
describe('isValidExpoPushToken', () => {
  it('accepts a real Expo token, both historical prefixes', () => {
    expect(isValidExpoPushToken('ExponentPushToken[abc123XYZ]')).toBe(true);
    expect(isValidExpoPushToken('ExpoPushToken[abc123XYZ]')).toBe(true);
  });

  it('rejects a bare string with no bracketed body', () => {
    expect(isValidExpoPushToken('ExponentPushToken')).toBe(false);
    expect(isValidExpoPushToken('ExponentPushToken[]')).toBe(false);
  });

  it('rejects a different provider’s token shape', () => {
    expect(isValidExpoPushToken('fcm-token-abc123')).toBe(false);
    expect(isValidExpoPushToken('')).toBe(false);
  });

  it('rejects a token with trailing garbage after the bracket', () => {
    expect(isValidExpoPushToken('ExponentPushToken[abc]extra')).toBe(false);
  });
});
