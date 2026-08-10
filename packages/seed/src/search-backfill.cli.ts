import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  initializeDatabase,
  isNull,
  listOrgIds,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import {
  indexCard,
  indexCardComment,
  indexMessage,
  indexPage,
  indexPageComment,
} from '@taskflow/api/search/indexer';

/**
 * Search backfill (ai/phase-8-search.md §2.5, Phase 8 Wave 2).
 *
 * The indexer relay only sees events that happen after it exists. This scans
 * the four source tables per org and upserts `search.documents` from the
 * rows already there — the same idempotency the relay relies on: every write
 * is an upsert keyed on (org_id, entity_type, entity_id), so re-running after
 * a failure is safe, and running against a live instance where the relay has
 * already indexed recent events is safe too (their rows are rewritten, never
 * duplicated).
 *
 * It reuses the relay's own `index*` functions rather than reimplementing the
 * projection — those functions RE-READ the source row regardless of what the
 * event payload said, which is exactly the property that makes a backfill and
 * a live relay the same code path instead of two that can drift.
 *
 * `pnpm --filter @taskflow/seed search:backfill`
 */

const here = dirname(fileURLToPath(import.meta.url));

/* Load the repo-root .env, exactly as cli.ts does — a process entry point
   reads argv and env before any validated config can exist (the guardrail-7
   CLI exemption). */
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

async function backfillOrg(orgId: OrgId): Promise<number> {
  return withOrgScope(orgId, async (tx) => {
    let written = 0;

    const cards = await tx.select({ id: schema.cards.id }).from(schema.cards);
    for (const card of cards) {
      if (await indexCard(orgId, { cardId: card.id })) written += 1;
    }

    const messages = await tx.select({ id: schema.messages.id }).from(schema.messages);
    for (const message of messages) {
      if (await indexMessage(orgId, { messageId: message.id })) written += 1;
    }

    const pages = await tx.select({ id: schema.pages.id }).from(schema.pages);
    for (const page of pages) {
      if (await indexPage(orgId, { pageId: page.id })) written += 1;
    }

    const cardComments = await tx
      .select({ id: schema.cardComments.id })
      .from(schema.cardComments)
      .where(isNull(schema.cardComments.deletedAt));
    for (const comment of cardComments) {
      if (await indexCardComment(orgId, { commentId: comment.id })) written += 1;
    }

    const pageComments = await tx
      .select({ id: schema.comments.id, pageId: schema.comments.pageId })
      .from(schema.comments)
      .where(isNull(schema.comments.deletedAt));
    for (const comment of pageComments) {
      if (await indexPageComment(orgId, { commentId: comment.id, pageId: comment.pageId })) {
        written += 1;
      }
    }

    return written;
  });
}

async function main(): Promise<void> {
  const url = requireAppUrl();
  initializeDatabase({ url, applicationName: 'taskflow-search-backfill' });

  try {
    const orgIds = await listOrgIds();
    console.warn(`Backfilling search.documents for ${String(orgIds.length)} org(s)...`);

    let total = 0;
    for (const id of orgIds) {
      const orgId = unsafeAsId<'OrgId'>(id);
      const written = await backfillOrg(orgId);
      total += written;
      console.warn(`  ${id}: ${String(written)} document(s) written`);
    }

    console.warn(`Done — ${String(total)} document(s) upserted across all orgs.`);
  } finally {
    await closeDatabase();
  }
}

await main();
