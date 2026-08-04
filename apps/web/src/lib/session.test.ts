import { describe, expect, it, beforeEach } from 'vitest';
import { useSession } from './session.js';

/**
 * `userId` — the client's own identity, read from the access token.
 *
 * Nothing else on the client carries it: `SessionResponse` deliberately omits
 * it (`session-response.ts`), so `adopt()` has to pull it out of the JWT
 * itself. That extraction has no server-side test coverage — it never reaches
 * the API — so a claim-name typo or a base64url edge case would otherwise only
 * surface as "the comment edit button never appears for anyone."
 */

function fakeAccessToken(claims: Record<string, unknown>): string {
  const base64url = (value: string): string =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  // The signature is never checked client-side (session.ts's own comment on
  // decodeUserId) — the server verifies the real token independently.
  return `${header}.${payload}.unsigned`;
}

beforeEach(() => {
  useSession.getState().clear();
});

describe('adopt', () => {
  it('reads userId from the sub claim of the access token', () => {
    const accessToken = fakeAccessToken({ sub: '019faee8-0000-7000-8000-000000000009' });

    useSession.getState().adopt({ accessToken, expiresInSeconds: 900, sessionId: 'sess-1' });

    expect(useSession.getState().userId).toBe('019faee8-0000-7000-8000-000000000009');
    expect(useSession.getState().sessionId).toBe('sess-1');
    // The two are different identifiers — the bug this exists to prevent is
    // treating one as the other (comment-section.tsx used to compare
    // `sessionId` against a comment's `authorId`, which can never match).
    expect(useSession.getState().userId).not.toBe(useSession.getState().sessionId);
  });

  it('sets userId to null for a token with no sub claim, rather than throwing', () => {
    const accessToken = fakeAccessToken({ role: 'member' });
    expect(() => {
      useSession.getState().adopt({ accessToken, expiresInSeconds: 900, sessionId: 'sess-2' });
    }).not.toThrow();
    expect(useSession.getState().userId).toBeNull();
  });

  it('sets userId to null for a malformed token, rather than throwing', () => {
    expect(() => {
      useSession
        .getState()
        .adopt({ accessToken: 'not-a-jwt', expiresInSeconds: 900, sessionId: 'sess-3' });
    }).not.toThrow();
    expect(useSession.getState().userId).toBeNull();
  });
});

describe('clear', () => {
  it('drops userId along with everything else', () => {
    const accessToken = fakeAccessToken({ sub: '019faee8-0000-7000-8000-000000000009' });
    useSession.getState().adopt({ accessToken, expiresInSeconds: 900, sessionId: 'sess-1' });
    expect(useSession.getState().userId).not.toBeNull();

    useSession.getState().clear();

    expect(useSession.getState().userId).toBeNull();
  });
});
