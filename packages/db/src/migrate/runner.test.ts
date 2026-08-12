import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertDisposableDatabase,
  MIGRATION_LOCK_KEY,
  verify,
  withMigrationLock,
} from './runner.js';
import { migrationsDir, TEST_MIGRATION_URL } from '../testing/index.js';

const { Client } = pg;

/**
 * The guard on `verify` (PLAN.md §12).
 *
 * `verify` reverts every migration before re-applying them, so it drops every
 * table and all of their contents. Pointed at `taskflow` it deleted a real org,
 * project, board and card, and printed `verify: OK` — success and total data
 * loss produce identical output, which is why this needs a test rather than a
 * comment.
 *
 * No database required: every case here must be decided before a connection is
 * opened, and one of them asserts exactly that.
 */

const DEV = 'postgresql://taskflow_migrator:secret@localhost:5433/taskflow';
const TEST = 'postgresql://taskflow_migrator:secret@localhost:5433/taskflow_test';

describe('assertDisposableDatabase', () => {
  it('accepts a database named for disposal', () => {
    expect(() => {
      assertDisposableDatabase(TEST);
    }).not.toThrow();
  });

  it('refuses the development database', () => {
    expect(() => {
      assertDisposableDatabase(DEV);
    }).toThrow(/refusing to run against "taskflow"/);
  });

  /**
   * `taskflow` is a PREFIX of `taskflow_test`, so a substring check would pass
   * both and a check anchored at the wrong end would pass neither. The suffix is
   * the whole rule; this pins it.
   */
  it('refuses a database that merely contains the word test', () => {
    expect(() => {
      assertDisposableDatabase('postgresql://u:p@localhost:5433/test_fixtures');
    }).toThrow(/refusing to run against "test_fixtures"/);
  });

  it('refuses a connection string it cannot read a database name from', () => {
    expect(() => {
      assertDisposableDatabase('not-a-url');
    }).toThrow(/could not read a database name/);
  });
});

describe('verify', () => {
  /**
   * Port 1 refuses every connection, so anything that reaches the network fails
   * with ECONNREFUSED. Getting the guard's message back instead is the proof
   * that the refusal happens before the first `down` — a check that ran after it
   * would be reporting on data that was already gone.
   */
  it('refuses a non-disposable target without connecting', async () => {
    await expect(
      verify({
        migrationUrl: 'postgresql://taskflow_migrator:secret@localhost:1/taskflow',
        migrationsDir: migrationsDir(),
      }),
    ).rejects.toThrow(/refusing to run against "taskflow"/);
  });
});

/**
 * Proves the advisory lock `up`/`down`/`status` all take actually serializes
 * two holders against real Postgres, rather than trusting that a
 * `pg_advisory_lock` call does what its name says.
 *
 * `up`'s own `applyMigrations` (`packages/db/src/testing/index.ts`) runs
 * concurrently across every test package's setup in real CI, and the bug
 * this lock exists to fix — two callers both reading a migration as "not yet
 * applied" and racing to apply it — reproduced there as a raw Postgres
 * catalog error with no hint that concurrency was the actual cause. Testing
 * the lock primitive directly, against the exact key `runner.ts` uses,
 * proves the mechanism the fix depends on without touching the shared
 * `taskflow_test` schema's migration state, which every other suite in the
 * same run also depends on staying intact.
 */
describe('MIGRATION_LOCK_KEY', () => {
  it('blocks a second holder until the first releases', async () => {
    const holder = new Client({ connectionString: TEST_MIGRATION_URL });
    const contender = new Client({ connectionString: TEST_MIGRATION_URL });
    await holder.connect();
    await contender.connect();

    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      // A short lock_timeout turns "the second connection blocks forever"
      // into a fast, provable refusal instead of a hung test. Asserting the
      // SQLSTATE, not just a message that happens to contain "lock", is what
      // actually distinguishes a genuine lock-timeout refusal from some
      // unrelated Postgres error that happens to mention one.
      await contender.query("SET lock_timeout = '200ms'");
      await expect(
        contender.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]),
      ).rejects.toMatchObject({ code: '55P03' });

      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);

      // Released — the same request that just failed must now succeed
      // immediately, proving the earlier refusal was the lock and not
      // something else about the connection or the key.
      await contender.query('SET lock_timeout = 0');
      const { rowCount } = await contender.query('SELECT pg_advisory_lock($1)', [
        MIGRATION_LOCK_KEY,
      ]);
      expect(rowCount).toBe(1);
      await contender.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      await holder.end();
      await contender.end();
    }
  });

  /**
   * The test above proves the raw `pg_advisory_lock` primitive serializes
   * two connections. This one proves `withMigrationLock` itself — the thing
   * `up`/`down`/`status` actually call — turns a real SQLSTATE 55P03 into
   * its friendlier message, rather than trusting that branch by inspection.
   */
  it('reports a timed-out acquisition with a message naming the cause', async () => {
    const holder = new Client({ connectionString: TEST_MIGRATION_URL });
    const contender = new Client({ connectionString: TEST_MIGRATION_URL });
    await holder.connect();
    await contender.connect();

    try {
      await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

      // 200ms override, not the real 60s production default — same code
      // path, same SQLSTATE-mapping branch, without an actual minute-long
      // wait in the test suite. See withMigrationLock's own note on why the
      // parameter exists at all.
      await expect(
        withMigrationLock(contender, () => Promise.resolve('unreachable'), '200ms'),
      ).rejects.toThrow(/timed out.*waiting for the migration lock/i);

      await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      await holder.end();
      await contender.end();
    }
  });
});
