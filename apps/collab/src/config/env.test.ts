import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

/**
 * PEM-shaped, not a real key — see `apps/api/src/config/env.test.ts`'s
 * identical fixture for why the block label is "TEST FIXTURE" rather than
 * "PUBLIC KEY" (gitleaks' `private-key` rule matches the header alone).
 */
const PEM_KEY = Buffer.from(
  '-----BEGIN TEST FIXTURE-----\nfake\n-----END TEST FIXTURE-----',
).toString('base64');

const valid = {
  DATABASE_URL: 'postgresql://taskflow_app:secret@localhost:5432/taskflow',
  DATABASE_COLLAB_URL: 'postgresql://taskflow_collab:secret@localhost:5432/taskflow',
  JWT_PUBLIC_KEY: PEM_KEY,
  WEB_ORIGIN: 'http://localhost:5173',
};

describe('parseEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe('development');
    expect(env.COLLAB_PORT).toBe(3002);
  });

  it('rejects a variable that looks like ours but is misspelled', () => {
    expect(() => parseEnv({ ...valid, JWT_PUBLIC_KEYY: PEM_KEY })).toThrow(/JWT_PUBLIC_KEYY/);
    expect(() => parseEnv({ ...valid, COLLAB_PORTT: '3002' })).toThrow(/COLLAB_PORTT/);
  });

  /**
   * The regression this suite exists for: `JWT_PRIVATE_KEY` and
   * `JWT_STATE_SECRET` are apps/api's alone (packages/security/src/jwt.ts's
   * file header — this gateway verifies, it never mints), but both are
   * spelled correctly and legitimately present in a developer's shared root
   * `.env` alongside `JWT_PUBLIC_KEY`. Before this app was taught about
   * them, a real boot against a real `.env` refused to start over two
   * perfectly correct variables — the exact failure mode this file's own
   * `KNOWN_VARIABLES` comments document for every `DATABASE_*` sibling role,
   * just not caught here until a real boot found it, because every other
   * test in this file constructs `Env` with a tidy fixture rather than a
   * realistic shared `.env`.
   */
  it('accepts JWT_PRIVATE_KEY and JWT_STATE_SECRET, which belong to apps/api alone', () => {
    expect(() =>
      parseEnv({
        ...valid,
        JWT_PRIVATE_KEY: PEM_KEY,
        JWT_STATE_SECRET: Buffer.alloc(32, 1).toString('base64'),
      }),
    ).not.toThrow();
  });

  it('accepts variables belonging to other TaskFlow services', () => {
    expect(() =>
      parseEnv({
        ...valid,
        DATABASE_MIGRATION_URL: 'postgresql://taskflow_migrator:s@localhost:5432/taskflow',
        REALTIME_PORT: '3001',
      }),
    ).not.toThrow();
  });
});
