import { eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { errors } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { systemSettingsUpdated } from './events.js';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';
import { invalidateSystemSettingsCache } from './system-settings-cache.js';

/**
 * Runtime-configurable platform settings (migration 0114).
 *
 * Read through `withPlatformAdminScope` — no RLS, no per-org scoping, these
 * are deployment-wide operational knobs. Updated through the operator console's
 * Config tab.
 *
 * Every value is stored as JSONB. The caller parses with Zod at the route
 * boundary — this service treats values as opaque `unknown`.
 */

export type SystemSettings = Record<string, unknown>;

export interface SystemSettingsDeps {
  readonly events: EventBus;
}

/**
 * Read all system settings as a flat key→value map.
 */
export async function getAllSettings(): Promise<SystemSettings> {
  return withPlatformAdminScope(async (tx) => {
    const rows = await tx.select().from(schema.systemSettings);
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  });
}

/**
 * Read a single setting by key. Returns `undefined` if not found.
 */
export async function getSetting(key: string): Promise<unknown> {
  return withPlatformAdminScope(async (tx) => {
    const rows = await tx
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, key))
      .limit(1);
    return rows[0]?.value;
  });
}

/**
 * Update one or more system settings. Upserts — a key that does not yet exist
 * is created, a key that does is updated.
 */
export async function updateSettings(
  deps: SystemSettingsDeps,
  operator: PlatformOperator,
  settings: readonly { readonly key: string; readonly value?: unknown }[],
): Promise<SystemSettings> {
  const effective = settings.filter((s) => s.value !== undefined);
  if (effective.length === 0) throw errors.validation({ settings: 'Nothing to change.' });

  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    for (const { key, value } of effective) {
      await tx
        .insert(schema.systemSettings)
        .values({
          key,
          value,
          description: '',
          updatedBy: operator.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.systemSettings.key,
          set: {
            value,
            updatedBy: operator.userId,
            updatedAt: now,
          },
        });
    }
  });

  /* Invalidate the in-process cache so the next request picks up the new
     values immediately rather than waiting up to 30 s for the TTL to expire.
     This matters most for maintenance_mode: an operator flipping it off
     expects the site to come back instantly. */
  invalidateSystemSettingsCache();

  await recordOperatorAction(
    operator.userId,
    'config.settings.update',
    { keys: effective.map((s) => s.key) },
  );

  await deps.events.publish([
    createEvent(
      systemSettingsUpdated,
      { keys: effective.map((s) => s.key), operatorUserId: operator.userId },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return getAllSettings();
}
