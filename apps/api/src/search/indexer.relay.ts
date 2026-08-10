import {
  and,
  claimPending,
  eq,
  hasSearchDatabase,
  inArray,
  markDispatched,
  schema,
  withOrgScope,
  withSearchScope,
  type OutboxRow,
} from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import type { Logger } from '@taskflow/observability';
import {
  cardArchived,
  cardCreated,
  cardUpdated,
  commentCreated,
  commentDeleted,
  commentUpdated,
} from '../work/events.js';
import {
  channelArchived,
  channelCreated,
  channelUpdated,
  messageDeleted,
  messageEdited,
  messageSent,
} from '../chat/events.js';
import {
  pageArchived,
  pageCommentCreated,
  pageCommentDeleted,
  pageCommentUpdated,
  pageContentUpdated,
  pageCreated,
  pageUpdated,
} from '../docs/events.js';

/**
 * The search indexer relay (ai/phase-8-search.md §2.2, migration 0045's own
 * header, Phase 8 Wave 2).
 *
 * Mirrors `docs/backlinks.relay.ts` in shape, for the same structural reason:
 * the CLAIM has to see every tenant's outbox in one pass (a job no
 * org-scoped connection can do), while the WORK must happen under the
 * ordinary `taskflow_app` role inside `withOrgScope` — `taskflow_search`
 * holds nothing on `search.documents` on purpose.
 *
 *  1. CLAIM, cross-tenant, as `taskflow_search` — `claimPending(tx, 'search')`
 *     over the per-consumer `outbox_dispatch` bookkeeping migration 0015
 *     established.
 *  2. WORK, per event, under `withOrgScope(orgId)` as `taskflow_app` — the
 *     indexer RE-READS the source row (the event deliberately carries only an
 *     excerpt or nothing at all; the text the projection needs lives in the
 *     source table), then upserts `search.documents`.
 *  3. MARK, in the same claim transaction — `markDispatched`.
 *
 * At-least-once by the claim contract; **idempotent by the
 * `(org_id, entity_type, entity_id)` unique key** — a redelivered event
 * upserts, never duplicates (the notification projection's
 * `notifications_event_user_key` precedent, §2.2).
 *
 * ## Channels are consumed but not documents
 *
 * §2.2's events table lists channel events with "name/topic, archive state",
 * but §2.1's DDL — the authority, already shipped in migration 0045 — closes
 * `entity_type` to `'card' | 'message' | 'page' | 'comment'`, and §2.7's
 * permalink list has no channel-only result. The resolution, which line 305
 * states directly: **channel archive hides its messages via the channel
 * row's state carried in `metadata`**. So `channel.archived` propagates to
 * the channel's MESSAGE documents, and `channel.created`/`channel.updated`
 * are consumed but produce no document row (a channel's name/topic is not a
 * search result in Wave 2 — searching "billing" finds messages IN #billing,
 * not the channel itself). The spec's own "name/topic" cell was aspirational;
 * this header is the correction, written per the codebase's standing habit of
 * correcting a wrong premise in the header rather than silently in the code.
 *
 * ## Deletes are real DELETEs of the document row
 *
 * Messages and comments tombstone their source rows (deleted_at) but the
 * indexer removes the document: a tombstoned row must not keep appearing in
 * search, and `archived = true` is reserved for the restore-able states
 * (card.archived, page.archived, channel.archived).
 */

/** The consumer name this relay claims under (migration 0045). */
export const SEARCH_CONSUMER = 'search';

export interface SearchDrainResult {
  readonly processed: number;
  /** Events that wrote or deleted at least one document row. */
  readonly written: number;
}

type SearchTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/* -------------------------------------------------------------------------- *
 * Payload narrowing — the notification projection's `asRecord` shape.
 * A malformed payload is SKIPPED, never thrown on: one bad event must not
 * poison the queue for every event behind it, and the claim is still marked
 * dispatched so the batch drains.
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function bool(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

/* -------------------------------------------------------------------------- *
 * Per-entity indexers — each opens its OWN withOrgScope, because the claim
 * connection (taskflow_search) holds no grant on search.documents and must
 * never be widened to get one.
 * -------------------------------------------------------------------------- */

/**
 * Re-reads a card and upserts its document row.
 *
 * The card.updated event deliberately does not carry the description — the
 * projection needs the full text, and the source row is the only place it
 * lives. A missing row (card hard-deleted) removes the document rather than
 * leaving a stale hit behind.
 *
 * Exported for the backfill script, which drives it with a synthetic
 * `{ cardId }` payload read from the source table — the function re-reads the
 * row either way, so the two callers cannot drift.
 */
export async function indexCard(orgId: OrgId, record: Record<string, unknown>): Promise<boolean> {
  const cardId = str(record, 'cardId');
  if (cardId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.cards.id,
        title: schema.cards.title,
        descriptionText: schema.cards.descriptionText,
        createdBy: schema.cards.createdBy,
        createdAt: schema.cards.createdAt,
        updatedAt: schema.cards.updatedAt,
        archivedAt: schema.cards.archivedAt,
        boardId: schema.cards.boardId,
        projectId: schema.cards.projectId,
      })
      .from(schema.cards)
      .where(eq(schema.cards.id, cardId))
      .limit(1);

    const card = rows[0];
    if (!card) {
      await deleteDocument(tx, orgId, 'card', cardId);
      return true;
    }

    await upsertDocument(tx, {
      orgId,
      entityType: 'card',
      entityId: card.id,
      title: card.title,
      body: card.descriptionText,
      authorId: card.createdBy,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      archived: card.archivedAt !== null,
      metadata: { board_id: card.boardId, project_id: card.projectId },
    });
    return true;
  });
}

/**
 * Card comments (comment.*). The event carries an excerpt; the full body is
 * re-read from `card_comments.body_text`. `board_id` for the metadata is also
 * re-read — joined from the comment's card — rather than taken from the event
 * payload, so the relay and the backfill cannot diverge over who supplied it
 * (the backfill's rows have no payload at all).
 */
export async function indexCardComment(
  orgId: OrgId,
  record: Record<string, unknown>,
): Promise<boolean> {
  const commentId = str(record, 'commentId');
  if (commentId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.cardComments.id,
        cardId: schema.cardComments.cardId,
        authorId: schema.cardComments.authorId,
        bodyText: schema.cardComments.bodyText,
        createdAt: schema.cardComments.createdAt,
        editedAt: schema.cardComments.editedAt,
      })
      .from(schema.cardComments)
      .where(eq(schema.cardComments.id, commentId))
      .limit(1);

    const comment = rows[0];
    if (!comment) {
      await deleteDocument(tx, orgId, 'comment', commentId);
      return true;
    }

    const cards = await tx
      .select({ boardId: schema.cards.boardId })
      .from(schema.cards)
      .where(eq(schema.cards.id, comment.cardId))
      .limit(1);
    const card = cards[0];
    /* A comment whose card is gone cannot be authorized against anything —
       the document would never pass the route's per-hit can(). Remove it. */
    if (!card) {
      await deleteDocument(tx, orgId, 'comment', commentId);
      return true;
    }

    await upsertDocument(tx, {
      orgId,
      entityType: 'comment',
      entityId: comment.id,
      title: null,
      body: comment.bodyText,
      authorId: comment.authorId,
      createdAt: comment.createdAt,
      updatedAt: comment.editedAt ?? comment.createdAt,
      archived: false,
      metadata: { card_id: comment.cardId, board_id: card.boardId },
    });
    return true;
  });
}

export async function indexMessage(
  orgId: OrgId,
  record: Record<string, unknown>,
): Promise<boolean> {
  const messageId = str(record, 'messageId');
  if (messageId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.messages.id,
        channelId: schema.messages.channelId,
        authorId: schema.messages.authorId,
        bodyText: schema.messages.bodyText,
        createdAt: schema.messages.createdAt,
        editedAt: schema.messages.editedAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);

    const message = rows[0];
    if (!message) {
      await deleteDocument(tx, orgId, 'message', messageId);
      return true;
    }

    await upsertDocument(tx, {
      orgId,
      entityType: 'message',
      entityId: message.id,
      title: null,
      body: message.bodyText,
      authorId: message.authorId,
      createdAt: message.createdAt,
      updatedAt: message.editedAt ?? message.createdAt,
      archived: false,
      metadata: { channel_id: message.channelId },
    });
    return true;
  });
}

/**
 * Docs pages — Wave 2 indexes TITLES only (§2.4). `body` stays NULL; the
 * named follow-up that reuses `materializeCurrentState` widens this same
 * handler. `page.content_updated` arrives here too and re-reads only title.
 */
export async function indexPage(orgId: OrgId, record: Record<string, unknown>): Promise<boolean> {
  const pageId = str(record, 'pageId');
  if (pageId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.pages.id,
        title: schema.pages.title,
        createdBy: schema.pages.createdBy,
        createdAt: schema.pages.createdAt,
        updatedAt: schema.pages.updatedAt,
        archivedAt: schema.pages.archivedAt,
        spaceId: schema.pages.spaceId,
      })
      .from(schema.pages)
      .where(eq(schema.pages.id, pageId))
      .limit(1);

    const page = rows[0];
    if (!page) {
      await deleteDocument(tx, orgId, 'page', pageId);
      return true;
    }

    await upsertDocument(tx, {
      orgId,
      entityType: 'page',
      entityId: page.id,
      title: page.title,
      body: null,
      authorId: page.createdBy,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      archived: page.archivedAt !== null,
      metadata: { space_id: page.spaceId },
    });
    return true;
  });
}

/** Docs comments (page.comment_*) — metadata is { page_id, space_id }, unlike
 * card comments. The SPACE id exists because the docs permalink needs it: the
 * `/docs` route renders the page tree from `space` and opens the page from
 * `page`, and the projection's own §2.1 contract says metadata carries what
 * building a hit's permalink needs. It is re-read from the page row, never
 * taken from the event payload, for the same reason card comments re-read
 * `board_id` — the relay and the backfill cannot diverge over who supplied it.
 */
export async function indexPageComment(
  orgId: OrgId,
  record: Record<string, unknown>,
): Promise<boolean> {
  const commentId = str(record, 'commentId');
  const pageId = str(record, 'pageId');
  if (commentId === null || pageId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.comments.id,
        authorId: schema.comments.authorId,
        bodyText: schema.comments.bodyText,
        createdAt: schema.comments.createdAt,
        editedAt: schema.comments.editedAt,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, commentId))
      .limit(1);

    const comment = rows[0];
    if (!comment) {
      await deleteDocument(tx, orgId, 'comment', commentId);
      return true;
    }

    const pages = await tx
      .select({ spaceId: schema.pages.spaceId })
      .from(schema.pages)
      .where(eq(schema.pages.id, pageId))
      .limit(1);
    const page = pages[0];
    /* A comment whose page is gone cannot be authorized or permalinked — the
       route's per-hit can() loads the page and would drop the hit anyway, so
       the document row is pure debt. Same shape as the card-comment branch. */
    if (!page) {
      await deleteDocument(tx, orgId, 'comment', commentId);
      return true;
    }

    await upsertDocument(tx, {
      orgId,
      entityType: 'comment',
      entityId: comment.id,
      title: null,
      body: comment.bodyText,
      authorId: comment.authorId,
      createdAt: comment.createdAt,
      updatedAt: comment.editedAt ?? comment.createdAt,
      archived: false,
      metadata: { page_id: pageId, space_id: page.spaceId },
    });
    return true;
  });
}

/**
 * Channel archive propagates to the channel's message documents (§2.2, line
 * 305). Implemented as a source-of-truth read: the message ids come from
 * `chat.messages` under RLS, never from a jsonb walk of the index — a
 * document whose channel is archived is exactly a document whose message row
 * names that channel.
 */
async function propagateChannelArchive(
  orgId: OrgId,
  record: Record<string, unknown>,
): Promise<boolean> {
  const channelId = str(record, 'channelId');
  const restored = bool(record, 'restored');
  if (channelId === null || restored === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const messages = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channelId));

    if (messages.length === 0) return false;

    await tx
      .update(schema.documents)
      .set({ archived: !restored })
      .where(
        and(
          eq(schema.documents.orgId, orgId),
          eq(schema.documents.entityType, 'message'),
          inArray(
            schema.documents.entityId,
            messages.map((message) => message.id),
          ),
        ),
      );
    return true;
  });
}

/* -------------------------------------------------------------------------- *
 * The upsert/delete primitives, shared by every indexer.
 * -------------------------------------------------------------------------- */

interface DocumentValues {
  readonly orgId: OrgId;
  readonly entityType: 'card' | 'message' | 'page' | 'comment';
  readonly entityId: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly authorId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archived: boolean;
  readonly metadata: Record<string, string>;
}

/**
 * Upserts one document row. `onConflictDoUpdate` keyed on
 * `(org_id, entity_type, entity_id)` — the unique key migration 0045 defines
 * — is the entire idempotency argument: a redelivered event rewrites the row
 * it already wrote instead of duplicating it. `id` is regenerated on the
 * update path (excluded from the conflict target), so an upsert never collides
 * on the projection row's own id.
 */
async function upsertDocument(tx: SearchTx, values: DocumentValues): Promise<void> {
  await tx
    .insert(schema.documents)
    .values({
      id: newId(),
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.documents.orgId, schema.documents.entityType, schema.documents.entityId],
      set: {
        title: values.title,
        body: values.body,
        authorId: values.authorId,
        updatedAt: values.updatedAt,
        archived: values.archived,
        metadata: values.metadata,
      },
    });
}

export async function deleteDocument(
  tx: SearchTx,
  orgId: OrgId,
  entityType: 'card' | 'message' | 'page' | 'comment',
  entityId: string,
): Promise<void> {
  await tx
    .delete(schema.documents)
    .where(
      and(
        eq(schema.documents.orgId, orgId),
        eq(schema.documents.entityType, entityType),
        eq(schema.documents.entityId, entityId),
      ),
    );
}

/* -------------------------------------------------------------------------- *
 * The drain loop — claim, work, mark.
 * -------------------------------------------------------------------------- */

/** Routes one claimed event to its indexer. Returns whether it wrote anything. */
async function handleEvent(row: OutboxRow): Promise<boolean> {
  const record = asRecord(row.payload);
  if (record === null) return false;
  const orgId = unsafeAsId<'OrgId'>(row.orgId);

  switch (row.name) {
    case cardCreated.name:
    case cardUpdated.name:
    case cardArchived.name:
      return indexCard(orgId, record);

    case commentCreated.name:
    case commentUpdated.name:
      return indexCardComment(orgId, record);
    case commentDeleted.name: {
      const commentId = str(record, 'commentId');
      if (commentId === null) return false;
      return withOrgScope(orgId, async (tx) => {
        await deleteDocument(tx, orgId, 'comment', commentId);
        return true;
      });
    }

    case messageSent.name:
    case messageEdited.name:
      return indexMessage(orgId, record);
    case messageDeleted.name: {
      const messageId = str(record, 'messageId');
      if (messageId === null) return false;
      return withOrgScope(orgId, async (tx) => {
        await deleteDocument(tx, orgId, 'message', messageId);
        return true;
      });
    }

    case channelArchived.name:
      return propagateChannelArchive(orgId, record);
    /* Consumed, never documents — see the file header. Still claimed and
       marked dispatched like every other event, so the queue drains. */
    case channelCreated.name:
    case channelUpdated.name:
      return false;

    case pageCreated.name:
    case pageUpdated.name:
    case pageArchived.name:
    case pageContentUpdated.name:
      return indexPage(orgId, record);

    case pageCommentCreated.name:
    case pageCommentUpdated.name:
      return indexPageComment(orgId, record);
    case pageCommentDeleted.name: {
      const commentId = str(record, 'commentId');
      if (commentId === null) return false;
      return withOrgScope(orgId, async (tx) => {
        await deleteDocument(tx, orgId, 'comment', commentId);
        return true;
      });
    }

    default:
      // Not a searchable event — consumed, never an error.
      return false;
  }
}

/** One claim-and-process batch. */
export async function drainSearchIndex(limit = 100): Promise<SearchDrainResult> {
  return withSearchScope(async (tx) => {
    const claimed = await claimPending(tx, SEARCH_CONSUMER, limit);
    if (claimed.length === 0) return { processed: 0, written: 0 };

    let written = 0;
    for (const row of claimed) {
      const handled = await handleEvent(row);
      if (handled) written += 1;
    }

    await markDispatched(
      tx,
      SEARCH_CONSUMER,
      claimed.map((row) => row.id),
    );

    return { processed: claimed.length, written };
  });
}

/** Drains until the backlog is empty. Bounded by `maxBatches`, matching `drainOutboxFully`. */
export async function drainSearchIndexFully(
  batchSize = 100,
  maxBatches = 50,
): Promise<SearchDrainResult> {
  let processed = 0;
  let written = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainSearchIndex(batchSize);
    processed += result.processed;
    written += result.written;
    if (result.processed < batchSize) break;
  }

  return { processed, written };
}

/**
 * Starts the relay, or does nothing if no search connection was configured.
 * Mirrors `startBacklinksRelay`'s shape and reasoning exactly: an API instance
 * with no `DATABASE_SEARCH_URL` is a valid deployment — it serves requests and
 * another instance drains the backlog (§2.2) — and what must never happen
 * silently is `taskflow_search`'s narrow claim grant being bypassed by a
 * fallback to the application role.
 */
export function startSearchIndexRelay(options: {
  readonly logger: Logger;
  readonly intervalMs?: number;
}): { readonly stop: () => void } {
  if (!hasSearchDatabase()) {
    options.logger.warn(
      'search indexer not started: DATABASE_SEARCH_URL is unset, so documents will accumulate unstaged',
    );
    return { stop: () => undefined };
  }

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const result = await drainSearchIndexFully();
      if (result.processed > 0) {
        options.logger.debug(
          { processed: result.processed, written: result.written },
          'search indexer drained outbox',
        );
      }
    } catch (error) {
      // Logged, never rethrown — the identical reasoning startAuditRelay's
      // own header gives: a transient blip must not take the process down,
      // and the events are still there for the next tick to retry.
      options.logger.error({ err: error }, 'search indexer tick failed');
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

const TICK_MS = 5_000;
