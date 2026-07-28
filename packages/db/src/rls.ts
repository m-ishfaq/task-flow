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

/** The tenant predicate for a given column. */
export function tenantPredicate(column = 'org_id'): string {
  return `${column} = NULLIF(current_setting('app.org_id', true), '')::uuid`;
}

/** The canonical predicate. Identical on every tenant table. */
export const TENANT_RLS_PREDICATE = tenantPredicate();

export interface TenantRlsOptions {
  /**
   * The column holding the tenant id, when it is not `org_id`.
   *
   * Exactly one table needs this: `identity.orgs`, where the tenant IS the row
   * and the column is therefore `id`. Adding an `org_id` column duplicating the
   * primary key would satisfy the convention and introduce a way for the two to
   * disagree, which is worse than a named exception in one place.
   */
  readonly column?: string;
}

/**
 * Full RLS setup for one tenant table.
 *
 * @param schema  schema name, e.g. 'work'
 * @param table   table name, e.g. 'cards'
 */
export function tenantRlsPolicy(schema: string, table: string, options?: TenantRlsOptions): string {
  const qualified = `${schema}.${table}`;
  const policy = `${table}_tenant_isolation`;
  const predicate = tenantPredicate(options?.column);

  return [
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${qualified} FORCE  ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${policy} ON ${qualified};`,
    `CREATE POLICY ${policy} ON ${qualified}`,
    `  USING (${predicate})`,
    `  WITH CHECK (${predicate});`,
  ].join('\n');
}

/**
 * The predicate for a row belonging to the CURRENT USER, across every org.
 *
 * A second session variable, `app.user_id`, set by `withUserScope`. It exists
 * for exactly one question that cannot be asked inside an org scope: "which
 * organizations am I a member of?" — the org switcher. Answering it requires
 * reading rows in orgs the caller has not selected, so no value of `app.org_id`
 * is correct.
 *
 * Two properties keep this from being a hole in guardrail 3:
 *
 *   - Policies built on it are `FOR SELECT` ONLY. A WITH CHECK on `user_id`
 *     would let a caller INSERT their own membership into any organization —
 *     self-service admission to every tenant, written as a read convenience.
 *   - `withOrgScope` and `withUserScope` each set BOTH variables, one to a value
 *     and the other to the empty string. Postgres ORs permissive policies
 *     together, so an inherited `app.user_id` surviving into an org-scoped
 *     transaction would widen that transaction beyond its org.
 */
export function selfPredicate(column = 'user_id'): string {
  return `${column} = NULLIF(current_setting('app.user_id', true), '')::uuid`;
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
