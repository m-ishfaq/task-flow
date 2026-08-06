import { describe, expect, it } from 'vitest';
import { signAccessToken } from '@taskflow/security';
import { originAllowed } from './auth.js';

/**
 * The origin check (ai/phase-6-docs.md §3.3), and a smoke test that this
 * module signs and verifies against the same `@taskflow/security` primitive
 * `apps/realtime` does.
 *
 * The full `authenticateConnection` — token verification composed with
 * `authorizeConnect`'s database-backed decision — is exercised end to end in
 * `authorize.test.ts` against real Postgres. Splitting the origin check out
 * here mirrors `apps/realtime/src/auth.test.ts`'s own split: this is the part
 * that needs no database and no real tuples, so it runs everywhere instantly.
 */

const ORIGINS = ['http://localhost:5173'];

describe('originAllowed', () => {
  it('accepts exactly the configured origins', () => {
    expect(originAllowed('http://localhost:5173', ORIGINS)).toBe(true);
    expect(originAllowed('http://evil.test', ORIGINS)).toBe(false);
  });

  it('refuses a MISSING origin rather than treating it as trusted', () => {
    expect(originAllowed(null, ORIGINS)).toBe(false);
    expect(originAllowed('', ORIGINS)).toBe(false);
  });

  it('does not accept a lookalike that merely contains an allowed origin', () => {
    expect(originAllowed('http://localhost:5173.evil.test', ORIGINS)).toBe(false);
    expect(originAllowed('http://evil.test/http://localhost:5173', ORIGINS)).toBe(false);
    expect(originAllowed('https://localhost:5173', ORIGINS)).toBe(false);
  });
});

describe('token signing smoke test', () => {
  it('signs a token this module can later verify (proves the shared primitive is wired)', async () => {
    const secret = Buffer.from('a'.repeat(32), 'utf8');
    const token = await signAccessToken(
      {
        userId: '0195ff20-0000-7000-8000-000000000001',
        sessionId: '0195ff20-0000-7000-8000-000000000501',
        authenticatedAt: Math.floor(Date.now() / 1000),
      },
      { secret },
    );

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});
