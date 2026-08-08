import { sql } from 'drizzle-orm';
import { withGlobalScope, type GlobalDb } from './client.js';

/**
 * The canonical-timezone fallback's middle rung (ai/phase-11.5-people.md §3.3).
 *
 * `people.profiles.timezone` starts NULL for every existing user — there is
 * deliberately NO migration-time backfill from `identity.notification_prefs`
 * (writing a backfilled guess would look exactly like something the person
 * entered, and it would never get corrected because it looks fine). Instead
 * `getProfile` resolves: profile's own value if set, else
 * `identity.notification_prefs.timezone` if that column AND a row for this
 * user exist, else null.
 *
 * ## Why this is a runtime existence check, not a schema assumption
 *
 * The `timezone` column on `notification_prefs` belongs to Phase 9's quiet
 * hours (ai/phase-9-notifications.md §3.9), which shipped WITHOUT it — quiet
 * hours were deferred, and this phase owns the canonical timezone. So the
 * column may exist by the time this code runs (a later slice added it) or may
 * not, and BOTH must be correct without this phase's code changing: the plan
 * is explicit that "the middle branch is written as a runtime existence check
 * (does the column/row resolve, not a compile-time assumption that it does)".
 *
 * The probe result is cached per process — `information_schema` answers
 * don't change while a server runs, and this is a read on every
 * `people.profile.get`.
 *
 * The direction is one-way: nothing here ever WRITES to
 * `notification_prefs`, and setting a profile timezone never writes back.
 */
let timezoneColumnKnown: boolean | null = null;

/**
 * Whether `identity.notification_prefs.timezone` exists in THIS database,
 * probed once per process.
 *
 * Raw SQL, not the query builder: the column is not in the Drizzle mirror
 * (it does not exist in any migration yet — see the file header), so there
 * is no typed table to select it from. The probe itself is a constant
 * information_schema lookup, parameterized only in the value read below.
 */
async function notificationPrefsHasTimezone(tx: GlobalDb): Promise<boolean> {
  if (timezoneColumnKnown !== null) return timezoneColumnKnown;

  const result = await tx.execute(sql`
    SELECT 1 AS present
      FROM information_schema.columns
     WHERE table_schema = 'identity'
       AND table_name = 'notification_prefs'
       AND column_name = 'timezone'
     LIMIT 1
  `);

  timezoneColumnKnown = result.rows.length > 0;
  return timezoneColumnKnown;
}

/**
 * The user's quiet-hours timezone, if that column and row exist.
 *
 * Returns null when the column is absent (Phase 9's Wave 2 quiet hours have
 * not shipped), when the user has no prefs row, or when the stored value is
 * blank — one answer for all three, which is what a fallback rung needs.
 */
export async function readNotificationPrefsTimezone(userId: string): Promise<string | null> {
  return withGlobalScope(async (tx) => {
    if (!(await notificationPrefsHasTimezone(tx))) return null;

    const result = await tx.execute(sql`
      SELECT timezone
        FROM identity.notification_prefs
       WHERE user_id = ${userId}
       LIMIT 1
    `);

    const record: Record<string, unknown> | undefined = result.rows[0];
    const value = record?.['timezone'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}
