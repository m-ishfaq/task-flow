import * as Y from 'yjs';
import {
  claimUnprocessedPageVersions,
  hasBacklinksDatabase,
  markBacklinksProcessed,
  outboxWriter,
  withBacklinksScope,
  withOrgScope,
  schema,
  eq,
  and,
} from '@taskflow/db';
import { unsafeAsId, type OrgId, type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import type { Logger } from '@taskflow/observability';
import { extractInternalLinks } from './backlinks.js';
import { pageContentUpdated } from './events.js';
import { materializeCurrentState } from './page-version.service.js';

/**
 * The backlinks relay (ai/phase-6-docs.md §3.10, migration 0025's own
 * header, Wave 3).
 *
 * Mirrors `tenancy/relay.ts`'s tick/timer shape closely — see that file's
 * own header for why a timer inside the API, not `apps/worker`, is this
 * codebase's established answer for "background reconciliation work with no
 * synchronous trigger." Two phases per tick, on purpose:
 *
 *   1. CLAIM, cross-tenant, as `taskflow_backlinks` — sees only
 *      `(id, org_id, page_id, created_at)` from `docs.page_versions`
 *      (never `state`) and `docs.backlink_dispatch`. This is the role that
 *      discovers WHICH pages changed.
 *   2. WORK, per distinct page, as the ordinary `taskflow_app` role under
 *      `withOrgScope` — materializes content, extracts links, rewrites
 *      `docs.backlinks`, emits `page.content_updated`. This is where a byte
 *      of actual page content is ever read, and it happens over the same
 *      connection and grant every other Docs mutation already uses.
 *
 * Several `page_versions` rows can name the same page in one batch
 * (compaction's autosave ticks run independently of this relay's own
 * cadence); they are folded to one materialize-and-rewrite per DISTINCT
 * page per tick, but every claimed row id still gets marked processed —
 * anything less would leave rows permanently unclaimed, silently growing
 * `docs.backlink_dispatch`'s anti-join scan forever.
 */

const TICK_MS = 5_000;

export interface RelayHandle {
  readonly stop: () => void;
}

export interface StartBacklinksRelayOptions {
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface DrainResult {
  readonly processed: number;
  readonly pagesUpdated: number;
}

async function rewriteBacklinks(orgId: OrgId, pageId: PageId): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    const state = await materializeCurrentState(tx, pageId);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);

    const targets = extractInternalLinks(doc.getXmlFragment('content'), pageId);

    // A full replace, never a patch — see backlinks.ts's own header and
    // migration 0025's comment on docs.backlinks: the only shape that can
    // never drift from what the document currently contains.
    await tx
      .delete(schema.backlinks)
      .where(and(eq(schema.backlinks.orgId, orgId), eq(schema.backlinks.sourcePageId, pageId)));

    if (targets.length > 0) {
      await tx.insert(schema.backlinks).values(
        targets.map((targetPageId) => ({
          orgId,
          sourcePageId: pageId,
          targetPageId,
        })),
      );
    }

    await outboxWriter.append(tx, [
      createEvent(pageContentUpdated, { pageId }, { orgId, actorId: null }),
    ]);
  });
}

/** One claim-and-process batch. Returns how many WAL rows and how many distinct pages were handled. */
export async function drainBacklinks(limit = 100): Promise<DrainResult> {
  return withBacklinksScope(async (tx) => {
    const claimed = await claimUnprocessedPageVersions(tx, limit);
    if (claimed.length === 0) return { processed: 0, pagesUpdated: 0 };

    const distinctPages = new Map<string, { orgId: OrgId; pageId: PageId }>();
    for (const row of claimed) {
      distinctPages.set(`${row.orgId}:${row.pageId}`, {
        orgId: unsafeAsId<'OrgId'>(row.orgId),
        pageId: unsafeAsId<'PageId'>(row.pageId),
      });
    }

    for (const { orgId, pageId } of distinctPages.values()) {
      await rewriteBacklinks(orgId, pageId);
    }

    await markBacklinksProcessed(
      tx,
      claimed.map((row) => ({ pageVersionId: row.id, orgId: row.orgId })),
    );

    return { processed: claimed.length, pagesUpdated: distinctPages.size };
  });
}

/** Drains until the backlog is empty. Bounded by `maxBatches`, matching `drainOutboxFully`. */
export async function drainBacklinksFully(batchSize = 100, maxBatches = 50): Promise<DrainResult> {
  let processed = 0;
  let pagesUpdated = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainBacklinks(batchSize);
    processed += result.processed;
    pagesUpdated += result.pagesUpdated;
    if (result.processed < batchSize) break;
  }

  return { processed, pagesUpdated };
}

/**
 * Starts the relay, or does nothing if no backlinks connection was
 * configured. Mirrors `startAuditRelay`'s shape and reasoning exactly: an
 * API instance with no `DATABASE_BACKLINKS_URL` is a valid deployment, and
 * what must never happen silently is `taskflow_backlinks`' narrow grant
 * being bypassed by a fallback to the application role.
 */
export function startBacklinksRelay(options: StartBacklinksRelayOptions): RelayHandle {
  if (!hasBacklinksDatabase()) {
    options.logger.warn(
      'backlinks relay not started: DATABASE_BACKLINKS_URL is unset, so page_versions will accumulate unprocessed',
    );
    return { stop: () => undefined };
  }

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const result = await drainBacklinksFully();
      if (result.processed > 0) {
        options.logger.debug(
          { processed: result.processed, pagesUpdated: result.pagesUpdated },
          'backlinks relay drained page_versions',
        );
      }
    } catch (error) {
      // Logged, never rethrown — the identical reasoning startAuditRelay's
      // own header gives: a transient blip must not take the process down,
      // and the rows are still there for the next tick to retry.
      options.logger.error({ err: error }, 'backlinks relay tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
