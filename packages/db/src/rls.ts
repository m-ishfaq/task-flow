/**
 * Row-Level Security conventions (PLAN.md §8.3).
 *
 * Every tenant table applies this exact SQL. It is generated rather than
 * hand-typed per migration because all three details below are load-bearing and
 * each was verified against a real Postgres by docker/postgres/rls-probe.sql:
 *
 *   FORCE   Without it, the table's OWNER bypasses every policy. Since the owner
 *           is taskflow_migrator, `ENABLE` alone would leave migrations — and
 *           anything running as that role — unfiltered. `ENABLE` alone protects
 *           nothing from the role that created the table.
 *
 *   NULLIF  The obvious `current_setting('app.org_id', true)::uuid` behaves
 *           differently for the two ways org context can go missing:
 *             unset -> NULL::uuid -> comparison NULL -> 0 rows   (correct)
 *             ''    -> ''::uuid   -> throws 22P02    -> HTTP 500 (wrong)
 *           Both are fail-closed in that nothing leaks, but the second turns a
 *           scoping bug into a server error and makes behaviour depend on how
 *           the context was cleared. NULLIF collapses both to NULL.
 *
 *   true    The second argument to current_setting returns NULL for a missing
 *           setting instead of raising.
 */

/** The canonical predicate. Identical on every tenant table. */
export const TENANT_RLS_PREDICATE =
  "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid";

/**
 * Full RLS setup for one tenant table.
 *
 * @param schema  schema name, e.g. 'work'
 * @param table   table name, e.g. 'cards'
 */
export function tenantRlsPolicy(schema: string, table: string): string {
  const qualified = `${schema}.${table}`;
  const policy = `${table}_tenant_isolation`;

  return [
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qualified} FORCE  ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${policy} ON ${qualified};`,
    `CREATE POLICY ${policy} ON ${qualified}`,
    `  USING (${TENANT_RLS_PREDICATE})`,
    `  WITH CHECK (${TENANT_RLS_PREDICATE});`,
  ].join('\n');
}

/**
 * Template for hand-written migrations.
 *
 * WITH CHECK matters as much as USING: USING filters what a query can SEE, while
 * WITH CHECK constrains what it may WRITE. Without it, a caller scoped to org A
 * could INSERT a row stamped with org B's id — invisible to them afterwards, but
 * very much present in org B's data.
 */
export const TENANT_RLS_POLICY_SQL = tenantRlsPolicy('<schema>', '<table>');
