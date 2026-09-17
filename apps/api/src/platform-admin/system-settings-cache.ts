import { schema, withPlatformAdminScope } from '@taskflow/db';

/**
 * Cached read of `platform.system_settings` — the operational knobs the
 * Config tab edits (maintenance mode, registration toggle, lockout
 * threshold, etc.).
 *
 * Follows the same TTL + single-flight pattern as `flag-evaluator.ts`:
 * the settings are read off the request path and cached so that a
 * maintenance-mode check on every incoming request never touches the
 * database. A toggle takes effect within one TTL window (30 s).
 *
 * `withPlatformAdminScope` is used because `system_settings` has no
 * `org_id` column — it is deployment-wide, and the platform-admin
 * scope is the one that admits the `platform` schema without RLS.
 */

const CACHE_TTL_MS = 30_000;

export interface SystemSettingsSnapshot {
  readonly maintenanceMode: boolean;
  readonly maintenanceMessage: string;
  readonly registrationEnabled: boolean;
  readonly stepUpMaxAgeMin: number;
  readonly lockoutThreshold: number;
  readonly lockoutDurationMin: number;
}

let cached: { readonly at: number; readonly settings: SystemSettingsSnapshot } | null = null;
let loading: Promise<SystemSettingsSnapshot> | null = null;

/**
 * Reads a setting value, tolerating the double-encoding bug where
 * `JSON.stringify` was called before writing to a `jsonb` column. The
 * column already serializes via the pg driver, so the stored value was
 * a JSON string like `"true"` instead of a JSON boolean `true`.
 */
function readSetting<T>(
  map: Map<string, unknown>,
  key: string,
  fallback: T,
  coerce: (v: unknown) => T,
): T {
  const raw = map.get(key);
  if (raw === undefined || raw === null) return fallback;
  return coerce(raw);
}

function parseSettings(
  rows: readonly { readonly key: string; readonly value: unknown }[],
): SystemSettingsSnapshot {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }
  return {
    maintenanceMode: readSetting(map, 'maintenance_mode', false, (v) => v === true || v === 'true'),
    maintenanceMessage: readSetting(
      map,
      'maintenance_message',
      'System is currently under maintenance. Please check back shortly.',
      (v) =>
        typeof v === 'string'
          ? v.replace(/^"|"$/g, '')
          : 'System is currently under maintenance. Please check back shortly.',
    ),
    registrationEnabled: readSetting(
      map,
      'registration_enabled',
      true,
      (v) => v !== false && v !== 'false',
    ),
    stepUpMaxAgeMin: readSetting(map, 'step_up_max_age_min', 5, (v) =>
      typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) || 5 : 5,
    ),
    lockoutThreshold: readSetting(map, 'lockout_threshold', 5, (v) =>
      typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) || 5 : 5,
    ),
    lockoutDurationMin: readSetting(map, 'lockout_duration_min', 15, (v) =>
      typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) || 15 : 15,
    ),
  };
}

async function loadSettings(): Promise<SystemSettingsSnapshot> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select({ key: schema.systemSettings.key, value: schema.systemSettings.value })
      .from(schema.systemSettings),
  );
  return parseSettings(rows);
}

/**
 * Returns the current settings snapshot, cached with a 30 s TTL and
 * single-flight so a burst of requests shares one database read.
 */
export async function getSystemSettings(): Promise<SystemSettingsSnapshot> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.settings;

  loading ??= loadSettings().then((settings) => {
    cached = { at: Date.now(), settings };
    return settings;
  });
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/**
 * Invalidates the cache so the next call to `getSystemSettings()`
 * re-reads from the database. Called after `updateSettings` writes.
 */
export function invalidateSystemSettingsCache(): void {
  cached = null;
}
