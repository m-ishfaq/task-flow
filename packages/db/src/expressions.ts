import { sql, type Column, type SQL } from 'drizzle-orm';

/**
 * Small SQL expressions that feature code needs but must not hand-write.
 *
 * Raw `sql` templates are banned outside this package (guardrail 7). That ban is
 * blunt on purpose — it cannot tell a parameterized fragment from a concatenated
 * one — so the answer when feature code legitimately needs a database-side
 * expression is to name it HERE, not to widen the rule.
 *
 * Every function below exists because a JavaScript equivalent would be wrong,
 * not merely slower.
 */

/**
 * `column = column + by`, evaluated by the database.
 *
 * The read-modify-write alternative is a lost-update bug: two concurrent
 * requests both read the same value and both write back the same value, so one
 * increment vanishes. For a failed-login counter that is not a rounding error —
 * the lockout fails to trigger under exactly the parallel guessing it exists to
 * stop.
 */
export function increment(column: Column, by = 1): SQL {
  return sql`${column} + ${by}`;
}

/** `column = column - by`. Same reasoning as `increment`. */
export function decrement(column: Column, by = 1): SQL {
  return sql`${column} - ${by}`;
}

/**
 * `COALESCE(column, fallback)` — sets a column only if it is currently null.
 *
 * Reading the row and branching in JavaScript would need the read and the write
 * to be in one transaction to be correct, and would still be two round trips.
 * This is one statement and cannot interleave.
 */
export function coalesce(column: Column, fallback: unknown): SQL {
  return sql`COALESCE(${column}, ${fallback})`;
}
