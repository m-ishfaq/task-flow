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

/**
 * A predicate compiled elsewhere, converted into a Drizzle expression.
 *
 * The bridge between `@taskflow/filter`'s compiler and the tenant-scoped
 * client. That compiler emits `{ sql, params }` with `$1`-style placeholders,
 * because it is also consumed by a Phase 10 worker that has no database — so
 * something has to turn those placeholders into Drizzle's own parameter
 * binding, and it belongs here rather than in feature code, where raw `sql` is
 * banned (guardrail 7).
 *
 * ## Why this is not a hole in that ban
 *
 * `fragment` is interpolated with `sql.raw`, which is exactly what the ban
 * exists to prevent — so the argument for it has to be specific:
 *
 *   - Every field name in the fragment came from the whitelist in
 *     `@taskflow/filter/fields.ts`, which is a list of literals in a source
 *     file. No caller string reaches it.
 *   - Every operator came from a fixed lookup table in the same package.
 *   - Every VALUE is a `$n` placeholder, split out below and passed as a bound
 *     parameter. Values never enter the raw text.
 *
 * The split is what makes that last point enforceable rather than a promise:
 * this function cannot emit a value into the SQL text even if the compiler
 * tried to hand it one, because it only ever copies the literal segments
 * between placeholders.
 */
export function compiledPredicate(fragment: string, params: readonly unknown[]): SQL {
  const parts = fragment.split(/\$(\d+)/g);
  const chunks: SQL[] = [];

  for (const [index, part] of parts.entries()) {
    if (index % 2 === 0) {
      // Literal SQL between placeholders — operators, parentheses, and column
      // expressions from the whitelist.
      if (part.length > 0) chunks.push(sql.raw(part));
      continue;
    }

    /* A placeholder. `$1` is the first parameter, so the index is one-based.
       An out-of-range reference means the compiler and this function disagree
       about numbering, which would silently bind undefined — so it throws. */
    const position = Number(part) - 1;
    if (position < 0 || position >= params.length) {
      throw new Error(`Compiled predicate references $${part}, which was not supplied.`);
    }
    chunks.push(sql`${params[position]}`);
  }

  return sql.join(chunks, sql``);
}
