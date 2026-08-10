import { eq, schema, withUserScope } from '@taskflow/db';
import type { UserId } from '@taskflow/contracts';

/**
 * Ringing preferences — a repository, not a service (ai/phase-13-webrtc.md §7).
 *
 * ## `withUserScope`, not `withOrgScope`, and that is the whole design
 *
 * A ringtone is yours and the same wherever you sign in — the shape
 * `display_name` and `identity.notification_prefs` already have. Every route
 * reading it is a `selfRoute`, which resolves NO org, so an org-scoped read
 * would have nothing to scope by. `identity.call_prefs`' RLS keys on
 * `app.user_id` for exactly that reason (migration 0042).
 *
 * ## Why this is not a `*.service.ts` file
 *
 * Guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and the rule is scoped by filename precisely so repositories are not
 * forced to invent one per row. `notification-prefs.ts` is the established
 * precedent and this is the same shape: nobody needs an audit entry for
 * somebody choosing a different ringtone, and emitting one would put a stream
 * of meaningless rows into a log that four subsystems consume.
 */

export type Ringtone = (typeof schema.RINGTONES)[number];

export interface CallPrefs {
  readonly ringtone: Ringtone;
  readonly ringEnabled: boolean;
}

/**
 * The coded default, applied when there is no row.
 *
 * Absence means the default rather than "off" — `notification_prefs`' own
 * absence rule and `FLAGS`' `defaultValue`. Somebody who has never opened
 * settings should have a phone that rings.
 */
export const DEFAULT_CALL_PREFS: CallPrefs = { ringtone: 'classic', ringEnabled: true };

function isRingtone(value: string): value is Ringtone {
  return (schema.RINGTONES as readonly string[]).includes(value);
}

export async function readCallPrefs(userId: UserId): Promise<CallPrefs> {
  return withUserScope(userId, async (tx) => {
    const rows = await tx
      .select({ ringtone: schema.callPrefs.ringtone, ringEnabled: schema.callPrefs.ringEnabled })
      .from(schema.callPrefs)
      .where(eq(schema.callPrefs.userId, userId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return DEFAULT_CALL_PREFS;

    /* Narrowed rather than cast. The CHECK constraint means the database can
       only hold a known value today — but this row crosses into a typed API
       output here, and a widened CHECK in a future migration would otherwise
       reach the client as a tone it has no synthesizer for, which presents as
       a phone that stopped ringing. */
    return {
      ringtone: isRingtone(row.ringtone) ? row.ringtone : DEFAULT_CALL_PREFS.ringtone,
      ringEnabled: row.ringEnabled,
    };
  });
}

export async function writeCallPrefs(userId: UserId, prefs: CallPrefs): Promise<CallPrefs> {
  await withUserScope(userId, async (tx) => {
    const now = new Date();

    /* Upsert rather than read-then-branch: two tabs saving at once would race
       between the read and the insert, and one would fail on the primary key.
       The conflict target IS the primary key, so this is one statement and
       cannot interleave. */
    await tx
      .insert(schema.callPrefs)
      .values({ userId, ringtone: prefs.ringtone, ringEnabled: prefs.ringEnabled, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.callPrefs.userId,
        set: { ringtone: prefs.ringtone, ringEnabled: prefs.ringEnabled, updatedAt: now },
      });
  });

  return prefs;
}
