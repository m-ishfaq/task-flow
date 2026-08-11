import { sql } from 'drizzle-orm';
import { withOrgScope } from './client.js';
import type { OrgId } from './client.js';

/**
 * The per-token daily quota (migration 0052, ai/phase-10-automation.md §6.5).
 *
 * ## Why this lives in packages/db
 *
 * The same reason `consumeAutomationBudget` does: it needs one raw statement,
 * and raw `sql` outside this package is a lint error — deliberately. The
 * ceiling lives in the statement's WHERE, so the database adjudicates a race
 * rather than a count-then-write the caller could get wrong.
 *
 * ## Why durable
 *
 * An in-process window forgives everyone on restart, which is the state an
 * attacker restarts you to reach. The telephony velocity limiter is only
 * permitted to be in-process because a durable spend ledger sits behind it;
 * nothing sits behind this counter, so it lives in Postgres like the TURN
 * issuance ledger and the automation budget.
 *
 * ## The two counters
 *
 * Every token-authenticated request consumes `used_count`; a request to a
 * route declaring `quotaClass: 'expensive'` also consumes `expensive_count`.
 * Both ceilings are in the same statement's WHERE, so an expensive request is
 * refused when EITHER is exhausted while a normal request is only refused by
 * the daily total — the expensive class is an addition, never a substitute.
 *
 * ## The day boundary
 *
 * `quota_date` is the UTC day the counters apply to. A stale date means
 * yesterday's row, and the CASE resets both counters to 1 rather than
 * incrementing — so the first request of a new day rolls the row over in the
 * same atomic statement that consumes it. The date is computed in JavaScript
 * (`toISOString` is always UTC), so the JS-computed day and the stored
 * `quota_date` can never disagree on a timezone.
 *
 * ## The `last_used_at` throttle
 *
 * The list view's "last used" lives on `platform.api_tokens.last_used_at`
 * (0050, 0053) — the row the list reads — and is written here, throttled to
 * once per minute, in the same transaction as the quota upsert. The minute
 * guard lives in that UPDATE's WHERE: it either writes or it does nothing,
 * so a per-minute request cannot churn the field. It runs only when the
 * quota was consumed — a refused request writes nothing, the same
 * discipline as the counters themselves.
 */

/** Every token-authenticated request counts toward this daily total. */
export const API_TOKEN_DAILY_QUOTA = 100_000;

/** The closed expensive class (search, analytics, export, telephony) counts here too. */
export const API_TOKEN_EXPENSIVE_DAILY_QUOTA = 2_000;

/** Which counter set a request consumes: the route's `quotaClass` meta. */
export type ApiTokenQuotaClass = 'normal' | 'expensive';

/**
 * Consumes one unit of `tokenId`'s daily quota, under `orgId`'s scope.
 *
 * Returns true when consumed, false when the token is at its ceiling — and
 * consumes NOTHING in that case, so a refused request cannot itself exhaust
 * the allowance (the automation budget's identical property). `tokenId` is
 * the token's row id, which the auth path already puts on the principal as
 * `sessionId`.
 */
export async function consumeApiTokenQuota(
  orgId: OrgId,
  tokenId: string,
  quotaClass: ApiTokenQuotaClass,
): Promise<boolean> {
  const expensive = quotaClass === 'expensive';
  return withOrgScope(orgId, async (tx) => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await tx.execute(sql`
      INSERT INTO platform.api_token_quota (token_id, org_id, quota_date, used_count, expensive_count)
      VALUES (${tokenId}, ${orgId}, ${today}, 1, ${expensive ? 1 : 0})
      ON CONFLICT (token_id) DO UPDATE SET
        used_count = CASE
          WHEN platform.api_token_quota.quota_date <> ${today} THEN 1
          ELSE platform.api_token_quota.used_count + 1
        END,
        expensive_count = CASE
          /* On rollover the first request of the new day is THIS one: 1 if it
             was expensive, 0 if not — the same values the INSERT writes, so
             a day that began with a normal request's rollover grants the
             same expensive allowance as a day that began with a fresh row. */
          WHEN platform.api_token_quota.quota_date <> ${today} THEN ${expensive ? 1 : 0}
          WHEN ${expensive} THEN platform.api_token_quota.expensive_count + 1
          ELSE platform.api_token_quota.expensive_count
        END,
        quota_date = ${today}
      WHERE platform.api_token_quota.quota_date <> ${today}
         OR (platform.api_token_quota.used_count < ${API_TOKEN_DAILY_QUOTA}
             AND (${expensive} = false
                  OR platform.api_token_quota.expensive_count < ${API_TOKEN_EXPENSIVE_DAILY_QUOTA}))
      RETURNING used_count
    `);

    /* No row means the ON CONFLICT's WHERE excluded the update — the token is
       at its ceiling. An upsert that updates nothing is silent, which is why
       the RETURNING is what the decision reads rather than a separate SELECT
       that could race it (the automation budget's identical reasoning). */
    const consumed = (result.rowCount ?? 0) > 0;
    if (!consumed) return false;

    /* The list view's "last used" — once per minute, and only when something
       was actually consumed. The minute guard in the WHERE makes the write a
       no-op most of the time; a refused request writes nothing. */
    await tx.execute(sql`
      UPDATE platform.api_tokens
      SET last_used_at = now()
      WHERE id = ${tokenId}
        AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
    `);
    return true;
  });
}
