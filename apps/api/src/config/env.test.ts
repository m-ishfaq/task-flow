import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const valid = {
  DATABASE_URL: 'postgresql://taskflow_app:secret@localhost:5432/taskflow',
  MASTER_KEY_ID: 'mk-dev-1',
  MASTER_KEY_BASE64: KEY_A,
  JWT_SECRET: KEY_B,
  MAIL_HOST: 'localhost',
  MAIL_FROM: 'TaskFlow <no-reply@taskflow.test>',
  WEB_ORIGIN: 'http://localhost:5173',

  /* Object storage (§8.4). Required rather than optional for the same reason
     as MAIL_HOST: an attachment upload that fails at presign because a bucket
     name was never set is a broken feature found by a user, where an unset
     variable is a boot failure found by whoever deployed it. */
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'taskflow',
  STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
  STORAGE_BUCKET_ATTACHMENTS: 'taskflow-attachments',
  STORAGE_BUCKET_EXPORTS: 'taskflow-exports',
};

describe('parseEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3000);
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('coerces numeric variables, which arrive as strings', () => {
    const env = parseEnv({ ...valid, API_PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(env.API_PORT).toBe(8080);
    expect(env.DATABASE_POOL_MAX).toBe(25);
  });

  it.each(['DATABASE_URL', 'MASTER_KEY_BASE64', 'JWT_SECRET', 'WEB_ORIGIN'] as const)(
    'fails when %s is missing',
    (key) => {
      const { [key]: _removed, ...incomplete } = valid;
      expect(() => parseEnv(incomplete)).toThrow(new RegExp(key));
    },
  );

  describe('API_TRUST_PROXY', () => {
    it('defaults to trusting nothing', () => {
      // The safe default, and the one that makes request.ip the socket address.
      expect(parseEnv(valid).API_TRUST_PROXY).toBe(false);
    });

    it('accepts a hop count', () => {
      expect(parseEnv({ ...valid, API_TRUST_PROXY: '1' }).API_TRUST_PROXY).toBe(1);
    });

    it('accepts a CIDR list', () => {
      const env = parseEnv({ ...valid, API_TRUST_PROXY: '10.0.0.0/8,172.16.0.0/12' });
      expect(env.API_TRUST_PROXY).toBe('10.0.0.0/8,172.16.0.0/12');
    });

    it('rejects true', () => {
      // The setting this codebase shipped with, and the reason the variable
      // exists: it lets any caller name their own address in X-Forwarded-For,
      // which makes every per-IP rate limit opt-out.
      expect(() => parseEnv({ ...valid, API_TRUST_PROXY: 'true' })).toThrow(/hop count/);
    });
  });

  it('names the offending variable in the error', () => {
    // The whole point of failing at boot: the message has to say which variable,
    // or the operator is left grepping a stack trace at 3am.
    expect(() => parseEnv({ ...valid, WEB_ORIGIN: 'not-a-url' })).toThrow(/WEB_ORIGIN/);
  });

  it.each([
    ['too short', Buffer.alloc(16).toString('base64')],
    ['too long', Buffer.alloc(64).toString('base64')],
    ['placeholder text', 'CHANGE_ME_generate_a_32_byte_key'],
    ['empty', ''],
  ])('rejects a %s master key', (_label, value) => {
    // A truncated secret is a configuration mistake that must stop the boot. The
    // alternative is an AES error inside a request handler, months later.
    expect(() => parseEnv({ ...valid, MASTER_KEY_BASE64: value })).toThrow(/MASTER_KEY_BASE64/);
  });

  it('ignores the hundreds of variables the operating system contributes', () => {
    // The schema is NOT strict, and that is deliberate. An earlier version was,
    // which made the API unbootable on any real machine while every test here
    // passed — because the tests fed it a tidy fixture and the OS does not.
    expect(() =>
      parseEnv({ ...valid, PATH: '/usr/bin', WINDIR: 'C:\\Windows', SHELL: '/bin/bash' }),
    ).not.toThrow();
  });

  it('rejects a variable that looks like ours but is misspelled', () => {
    // The real failure: the intended variable is unset, so something runs on a
    // default it should not be. Naming the near-miss turns a long stare into a
    // one-line fix.
    expect(() => parseEnv({ ...valid, MASTER_KEY_BASE_64: 'x' })).toThrow(/MASTER_KEY_BASE_64/);
    expect(() => parseEnv({ ...valid, API_PORTT: '3000' })).toThrow(/API_PORTT/);
  });

  it('accepts variables belonging to other TaskFlow services', () => {
    // A developer's environment legitimately holds the migration URL and the
    // storage settings, which this app does not read.
    expect(() =>
      parseEnv({
        ...valid,
        DATABASE_MIGRATION_URL: 'postgresql://taskflow_migrator:s@localhost:5432/taskflow',
        STORAGE_BUCKET_EXPORTS: 'taskflow-exports',
        MAIL_HOST: 'localhost',
      }),
    ).not.toThrow();
  });

  it('accepts the WEB_ variables only apps/web reads', () => {
    /* These are read by vite.config.ts and by no server. They still have to be
       in the known set, because the `WEB_` prefix makes the misspelling check
       claim them — so an unlisted one does not merely go unvalidated, it stops
       the API booting with an error naming a variable that is spelled
       correctly. The one who would hit it is a developer pointing the dev
       server at a non-default backend, which is exactly when a confusing boot
       failure is most expensive. */
    expect(() =>
      parseEnv({
        ...valid,
        WEB_API_ORIGIN: 'http://localhost:3000',
        WEB_REALTIME_ORIGIN: 'http://localhost:3001',
        WEB_ALLOWED_HOSTS: '.ngrok-free.app,.ngrok.app',
      }),
    ).not.toThrow();
  });

  it('rejects reusing one secret for two purposes in production', () => {
    // Compromising either would compromise both, and the two keys could no
    // longer be rotated independently.
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', JWT_SECRET: KEY_A })).toThrow(
      /must be different/,
    );
  });

  it('allows it outside production, where fixtures reuse keys', () => {
    expect(() => parseEnv({ ...valid, JWT_SECRET: KEY_A })).not.toThrow();
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv({ ...valid, API_PORT: '70000' })).toThrow(/API_PORT/);
    expect(() => parseEnv({ ...valid, API_PORT: '0' })).toThrow(/API_PORT/);
  });
});
