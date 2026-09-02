import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { backfillAnalytics } from './analytics-backfill.js';

/**
 * Analytics backfill (Phase 11, ai/phase-11-analytics.md §2.2, §6).
 *
 * A freshly seeded database has no `analytics.card_transitions` and no rollups —
 * the projection relay only sees events that happen after it exists, and the
 * seed writes cards directly rather than emitting `card.status_changed`. So the
 * Insights dashboards are empty until this runs. It synthesizes a transition
 * history from the seeded cards and runs the real `refreshOrg` to build the
 * rollups the dashboards read — the analytics twin of `search:backfill`.
 *
 * `pnpm seed` runs this automatically at the end when DATABASE_URL is set; this
 * standalone entry point exists to re-run it on its own (after adding data, or
 * against an instance seeded before this existed).
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

function requireAppUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env, or export it directly.');
    process.exit(1);
  }
  return url;
}

async function main(): Promise<void> {
  const url = requireAppUrl();
  initializeDatabase({ url, applicationName: 'taskflow-analytics-backfill' });

  try {
    console.warn('Backfilling analytics (transitions + rollups) for all orgs...');
    const result = await backfillAnalytics((message) => {
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
