import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withAuditScope,
} from '@taskflow/db';
import { backfillAnalytics } from './analytics-backfill.js';

/**
 * Analytics backfill (Phase 11, ai/phase-11-analytics.md §2.2, §6).
 *
 * A freshly seeded database has no `analytics.card_transitions` and no rollups —
 * the projection relay only sees `card.status_changed` events that happen after
 * it exists, and the seed writes cards directly rather than emitting those. So
 * the Insights dashboards are empty until this runs. It synthesizes a transition
 * history from the seeded cards and runs the real `refreshOrg` to build the
 * rollups the dashboards read — the analytics twin of `search:backfill`.
 *
 * `pnpm seed` runs this automatically at the end when DATABASE_URL is set,
 * passing the ids it just seeded. This standalone entry point re-runs it on its
 * own, so it must DISCOVER the orgs — and it does so through the AUDIT role,
 * not the app role: `identity.orgs` has no RLS policy admitting `taskflow_app`
 * with `app.org_id` cleared (migration 0004), so `listOrgIds()` would return
 * zero. Migration 0037 gives `taskflow_audit` an explicit `USING (true)` read
 * of `identity.orgs`, which is exactly the "enumerate every tenant" grant this
 * needs.
 *
 * `pnpm --filter @taskflow/seed analytics:backfill`
 */

const here = dirname(fileURLToPath(import.meta.url));

/* Load the repo-root .env, exactly as cli.ts does — a process entry point
   reads env before any validated config can exist (the guardrail-7 CLI
   exemption). */
const envFile = resolve(here, '..', '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env, or export it directly.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const appUrl = requireEnv('DATABASE_URL');
  // The app role cannot enumerate identity.orgs (0004); the audit role can (0037).
  const auditUrl = requireEnv('DATABASE_AUDIT_URL');

  initializeDatabase({ url: appUrl, applicationName: 'taskflow-analytics-backfill' });
  initializeAuditDatabase({ url: auditUrl, applicationName: 'taskflow-analytics-backfill' });

  try {
    const rows = await withAuditScope(async (tx) =>
      tx.select({ id: schema.orgs.id }).from(schema.orgs),
    );
    const orgIds = rows.map((row) => row.id);
    console.warn(
      `Backfilling analytics (transitions + rollups) for ${String(orgIds.length)} org(s)...`,
    );

    const result = await backfillAnalytics(orgIds, (message) => {
      console.warn(message);
    });
    console.warn(
      `Done — ${String(result.transitions)} transition(s) synthesized across ` +
        `${String(result.orgs)} org(s), rollups refreshed.`,
    );
  } finally {
    await closeDatabase();
  }
}

await main();
