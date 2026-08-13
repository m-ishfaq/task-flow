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
 * `column @> ARRAY[value]::uuid[]` — does this `uuid[]` column contain `value`.
 *
 * Postgres's `@>` operator, not a JavaScript filter, because the caller wants
 * an index scan (a GIN index on the column) rather than a sequential one that
 * pulls every row into the app to check `.includes()`. Docs' subtree lookups
 * and nearest-ancestor-grant walk (ai/phase-6-docs.md §3.4, §3.5) both use
 * this against `docs.pages.ancestor_ids`.
 *
 * The `::uuid[]` cast is load-bearing, not decoration: a bound parameter
 * inside `ARRAY[$1]` has no type of its own, and without the cast Postgres
 * infers `text[]`, which has no `@>` operator against a `uuid[]` column —
 * confirmed against real Postgres (`operator does not exist: uuid[] @>
 * text[]`) before this cast was added.
 */
export function uuidArrayContains(column: Column, value: unknown): SQL {
  return sql`${column} @> ARRAY[${value}]::uuid[]`;
}

/**
 * `SUM(COALESCE(actual, estimated))` over the telephony spend ledger, as a
 * bigint rendered to text (Phase 7 Wave 1, ai/phase-7-voice.md §3.4).
 *
 * Named here rather than hand-written in `apps/api/src/telephony/spend-gate.ts`
 * for exactly the reason this file exists: raw `sql` is banned in feature code,
 * and the answer is a named expression, not an exemption.
 *
 * Two things about it are load-bearing:
 *
 *   - **The inner COALESCE, not `SUM(actual)`.** A ledger row the carrier has
 *     not billed yet has a NULL `actual_cents`, so summing that column alone
 *     counts every in-flight action as free. That is precisely the window an
 *     attacker exploits by placing calls faster than reconciliation runs. The
 *     conservative estimate stands in until the real figure arrives.
 *   - **The outer COALESCE to 0.** `SUM` over zero rows is NULL, not 0, and a
 *     NULL total parsed in JavaScript becomes `NaN` — which compares false
 *     against every threshold, so an org with no ledger history would read as
 *     permanently under its cap.
 *
 * Returned as text because a Postgres `bigint` exceeds what the driver will
 * hand back as a safe JavaScript number; the caller parses it explicitly.
 */
export function sumWithFallback(preferred: Column, fallback: Column): SQL<string> {
  return sql<string>`COALESCE(SUM(COALESCE(${preferred}, ${fallback})), 0)::text`;
}

/**
 * `SUM(column)`, grouped by whatever the caller's query groups by.
 *
 * For a column that can be NULL, `sumWithFallback` is almost certainly the
 * right function instead — this one exists for the simpler case of summing a
 * `NOT NULL` column, where there is nothing to fall back to. Returned as text
 * for the reason `sumWithFallback` and `countRows` both are: a Postgres
 * `bigint` sum exceeds a safe JavaScript number, so parsing is the caller's
 * job, done explicitly.
 */
export function sumColumn(column: Column): SQL<string> {
  return sql<string>`COALESCE(SUM(${column}), 0)::text`;
}

/**
 * `COUNT(column)`, grouped by whatever the caller's query groups by.
 *
 * Returned as text for the same reason `sumWithFallback` is: a Postgres
 * `bigint` count exceeds what the driver hands back as a safe JavaScript
 * number, so the caller parses it explicitly rather than trusting an implicit
 * cast.
 */
export function countRows(column: Column): SQL<string> {
  return sql<string>`COUNT(${column})::text`;
}

/**
 * `MIN(column)` over a text column, for collapsing a joined group to one value.
 *
 * The use it exists for: a query that already joins a row guaranteed unique
 * per group — the org's single owner — and needs that row's column in the
 * SELECT list without adding it to `GROUP BY`. Every non-null value in the
 * group is identical, so MIN is a deterministic pick rather than a real
 * aggregate, and NULL when the group has no such row.
 *
 * Deterministic matters more than it looks. If the "unique per group"
 * invariant ever broke — two owners on one org — this keeps returning the same
 * answer on every read, so the wrongness is stable and reportable instead of
 * flickering between two values depending on plan order.
 *
 * Lives here rather than at the call site because raw `sql` is banned in
 * feature code (guardrail 7), and the answer to that ban is a named expression
 * rather than an exemption — the reasoning `compiledPredicate` already states.
 */
export function minText(column: Column): SQL<string | null> {
  return sql<string | null>`MIN(${column})`;
}

/**
 * `COALESCE(preferred, fallback)` over two COLUMNS.
 *
 * Distinct from `coalesce` above, which takes a literal fallback for the
 * write path. This is for reads where the same fact lives in two places with
 * a clear precedence between them.
 *
 * The case it exists for: a person's display name. `identity.users
 * .display_name` is SEEDED at registration — what they typed on the signup
 * form — while `people.profiles.display_name` is what they later set on the
 * account page, on a row that is created lazily and is therefore absent for
 * most accounts. The profile wins where it exists; the signup value is what
 * everyone else has.
 *
 * Without this, the two columns drift into two answers and which one a
 * surface shows depends on which query somebody wrote first — the operator
 * console read the profile and showed nothing for every account that had
 * never opened the account page, including brand-new signups who had just
 * typed their name in.
 */
export function coalesceColumns(preferred: Column, fallback: Column): SQL<string | null> {
  return sql<string | null>`COALESCE(${preferred}, ${fallback})`;
}

/**
 * `MIN(COALESCE(preferred, fallback))` — the two above, composed.
 *
 * Its own function rather than nesting them, because `minText` takes a Column
 * and `coalesceColumns` returns an SQL expression, so the nested form does not
 * typecheck. Composing them here is better than widening `minText` to accept
 * either: a helper that takes "a column OR any expression" stops documenting
 * what it is for.
 *
 * The one caller: the org directory picks an owner's display name out of a
 * joined group. Every non-null row in that group is the same person (the join
 * is restricted to `role = 'owner'`), so MIN collapses the group rather than
 * aggregating anything, and COALESCE picks the profile name over the signup
 * one — see `coalesceColumns`.
 */
export function minCoalesced(preferred: Column, fallback: Column): SQL<string | null> {
  return sql<string | null>`MIN(COALESCE(${preferred}, ${fallback}))`;
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
