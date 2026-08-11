import { sql } from 'drizzle-orm';
import { withOrgScope } from './client.js';
import type { OrgId } from './client.js';

/**
 * The automation engine's durable execution budget (migration 0047,
 * ai/phase-10-automation.md §4 layer 3).
 *
 * ## Why this lives in packages/db rather than in the worker
 *
 * It needs one raw statement, and raw `sql` outside this package is a lint
 * error — deliberately. CLAUDE.md: "raw `sql` is banned in feature code and the
 * answer to that ban is a named expression, not an exemption." `sumWithFallback`
 * in `expressions.ts` is the same answer to the same question for the telephony
 * spend cap, and `docs-backlinks.ts` is the precedent for a whole named
 * repository function belonging to one consumer.
 *
 * The rule caught this on its first run: the statement was written inline in
 * the worker's own repository module, where it compiled and read fine and was
 * exactly the injection-surface shape the ban exists to keep out of feature
 * code.
 *
 * ## Why it is ONE statement
 *
 * A count-then-write lets two workers processing two events for the same org in
 * the same instant both read 999 and both write 1000. The insert-or-increment
 * below carries the ceiling in the `ON CONFLICT ... WHERE`, so the database
 * adjudicates — the `claimForScanning` pattern this codebase already relies on
 * for attachment scanning and first-answer-wins call answering.
 *
 * ## Why durable at all
 *
 * An in-process counter forgives everyone on restart, which is the state an
 * attacker restarts you to reach. Phase 13's TURN issuance budget makes the
 * identical argument; the telephony velocity limiter is only permitted to be
 * in-process because a durable spend ledger sits behind it, and nothing sits
 * behind this one.
 */

/**
 * Consumes one execution from `orgId`'s current hourly budget.
 *
 * Returns false when the org is at its ceiling — and consumes nothing in that
 * case, so a refused execution cannot itself exhaust the allowance.
 *
 * The window is a truncated hour rather than a rolling interval because a fixed
 * bucket is expressible as a single upsert, where a rolling window is not.
 */
export async function consumeAutomationBudget(orgId: OrgId, limit: number): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO platform.automation_budget (org_id, window_hour, executions)
      VALUES (${orgId}, date_trunc('hour', now()), 1)
      ON CONFLICT (org_id, window_hour) DO UPDATE
        SET executions = platform.automation_budget.executions + 1
        WHERE platform.automation_budget.executions < ${limit}
      RETURNING executions
    `);

    /* No row means the ON CONFLICT's WHERE excluded the update — the org is at
       its ceiling. An upsert that updates nothing is silent, which is why the
       RETURNING is what the decision reads rather than a separate SELECT that
       could race it. */
    return (result.rowCount ?? 0) > 0;
  });
}
