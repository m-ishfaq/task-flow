import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

/**
 * The worker's env contract (guardrail 3).
 *
 * Small on purpose — the schema is small. What is worth pinning is the part
 * that is a DECISION rather than a shape: that the automation claim role is
 * optional (a deployment without it is valid), and that `.strict()` refuses an
 * unknown variable rather than ignoring it.
 */

const valid = {
  DATABASE_URL: 'postgresql://taskflow_app:secret@localhost:5432/taskflow',
};

describe('parseEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const env = parseEnv(valid);

    expect(env.WORKER_PORT).toBe(3003);
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(2_000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('leaves the automation claim role optional', () => {
    /* A deployment with no `DATABASE_AUTOMATION_URL` is valid — it runs the
       health server and whatever else it is given, and the engine declines to
       start with a warning. The alternative, falling back to the application
       role, would silently bypass the narrow claim grant, which is the one
       thing `DATABASE_BACKLINKS_URL` and `DATABASE_SEARCH_URL` both exist to
       prevent. */
    expect(parseEnv(valid).DATABASE_AUTOMATION_URL).toBeUndefined();

    const configured = parseEnv({
      ...valid,
      DATABASE_AUTOMATION_URL: 'postgresql://taskflow_automation:s@localhost:5432/taskflow',
    });
    expect(configured.DATABASE_AUTOMATION_URL).toContain('taskflow_automation');
  });

  it('refuses a missing DATABASE_URL, naming it', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('parses a realistic process.env-shaped object, noise and all', () => {
    /* THE REGRESSION TEST FOR THIS FILE'S OWN FIRST BUG.
     *
     * The schema was written `.strict()`, this suite fed it a tidy four-key
     * fixture, every assertion passed — and the process died on its first real
     * boot listing PATH, HOME, SYSTEMROOT and two hundred other OS variables as
     * "unrecognized keys". `apps/api/src/config/env.ts` had already documented
     * that exact failure, in those words, including that a tidy fixture hid it.
     *
     * So this test feeds the NOISE. A fixture that looks like a real
     * environment is the only version of this assertion that can fail when the
     * schema goes strict again. */
    const env = parseEnv({
      ...valid,
      PATH: '/usr/bin:/bin',
      HOME: '/home/someone',
      SYSTEMROOT: 'C:\\Windows',
      npm_package_name: '@taskflow/worker',
      REALTIME_PORT: '3001',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
    });

    expect(env.WORKER_PORT).toBe(3003);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it('bounds the poll interval at both ends', () => {
    /* A floor because a 10 ms poll is a busy loop against Postgres; a ceiling
       because an interval measured in minutes makes an automation feel broken
       rather than slow. */
    expect(() => parseEnv({ ...valid, WORKER_POLL_INTERVAL_MS: '10' })).toThrow();
    expect(() => parseEnv({ ...valid, WORKER_POLL_INTERVAL_MS: '600000' })).toThrow();
    expect(parseEnv({ ...valid, WORKER_POLL_INTERVAL_MS: '5000' }).WORKER_POLL_INTERVAL_MS).toBe(
      5_000,
    );
  });
});
