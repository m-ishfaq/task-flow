import { describe, expect, it } from 'vitest';
import { assertDisposableDatabase, verify } from './runner.js';
import { migrationsDir } from '../testing/index.js';

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
