import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, initializeSearchDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { drainSearchIndex, drainSearchIndexFully } from './indexer.relay.js';
import { PostgresSearchProvider } from './postgres-provider.js';
import { parse, compare } from '@taskflow/filter';
import { schema, withOrgScope, eq } from '@taskflow/db';
import type { SearchProvider } from '@taskflow/contracts';

/**
 * The search indexer (ai/phase-8-search.md §2.2, migration 0045), against
 * real Postgres and the real `taskflow_search` role — not a stub. The claim
 * step's `FOR UPDATE`-lock policy (`WITH CHECK (false)`, migration 0016's
 * recipe) is exactly the kind of thing that looks correct in a migration and
 * silently returns zero rows if the role's grant is wrong — the standing
 * lesson of 0016 and 0025, and the reason every consumer relay tests this way.
 */

let admin: AdminConnection;
let created: OrgId[] = [];
let fixtureCounter = 0;
let provider: SearchProvider;

interface Fixture {
  readonly orgId: OrgId;
  readonly cardId: string;
  readonly messageId: string;
  readonly pageId: string;
  readonly commentId: string;
  readonly pageCommentId: string;
  readonly channelId: string;
  /** Inserts a synthetic outbox event for this org. */
  readonly emit: (name: string, payload: Record<string, unknown>) => Promise<void>;
  /**
   * Mirrors what the card service does atomically with the emit: write the
   * source row AND enqueue the event. The indexer re-reads the row — the
   * source is authoritative, the event is only the wake-up — so a test that
   * emits `card.archived` without touching `archived_at` would be testing a
   * state that production cannot produce.
   */
  readonly setCardArchived: (archived: boolean) => Promise<void>;
}

async function scaffold(slug: string): Promise<Fixture> {
  fixtureCounter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();
  const cardId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const pageCommentId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `sr-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key, next_card_number) VALUES ($1, $2, 'Project', 'PROJ', 1)`,
    [projectId, orgId],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank) VALUES ($1, $2, $3, 'Board', 'a0')`,
    [boardId, orgId, projectId],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank) VALUES ($1, $2, $3, $4, 'Backlog', 'a0')`,
    [listId, orgId, projectId, boardId],
  );
  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank)
     VALUES ($1, $2, $3, $4, $5, 1, 'Deploy outage', '{}'::jsonb, 'investigate the outage', 'a0')`,
    [cardId, orgId, projectId, boardId, listId],
  );
  await admin.query(
    `INSERT INTO work.card_comments (id, org_id, card_id, author_id, body, body_text)
     VALUES ($1, $2, $3, NULL, '{}'::jsonb, 'check the logs first')`,
    [commentId, orgId, cardId],
  );
  await admin.query(
    `INSERT INTO chat.channels (id, org_id, type, name) VALUES ($1, $2, 'public', 'incidents')`,
    [channelId, orgId],
  );
  await admin.query(
    `INSERT INTO chat.messages (id, org_id, channel_id, author_id, body, body_text)
     VALUES ($1, $2, $3, NULL, '{}'::jsonb, 'is anyone looking at the outage')`,
    [messageId, orgId, channelId],
  );
  await admin.query(`INSERT INTO docs.spaces (id, org_id, name) VALUES ($1, $2, 'Runbook')`, [
    spaceId,
    orgId,
  ]);
  await admin.query(
    `INSERT INTO docs.pages (id, org_id, space_id, parent_page_id, title, rank, ancestor_ids)
     VALUES ($1, $2, $3, NULL, 'Outage runbook', 'a0', '{}')`,
    [pageId, orgId, spaceId],
  );
  await admin.query(
    `INSERT INTO docs.comments (id, org_id, page_id, anchor_from, anchor_to, body, body_text)
     VALUES ($1, $2, $3, '\\x01'::bytea, '\\x02'::bytea, '{}'::jsonb, 'runbook needs a rollback section')`,
    [pageCommentId, orgId, pageId],
  );
  await admin.setOrg(null);
  created.push(orgId);

  return {
    orgId,
    cardId,
    messageId,
    pageId,
    commentId,
    pageCommentId,
    channelId,
    emit: async (name, payload) => {
      await admin.setOrg(orgId);
      await admin.query(
        `INSERT INTO platform.outbox (id, org_id, name, version, occurred_at, payload)
         VALUES (gen_random_uuid(), $1, $2, 1, now(), $3::jsonb)`,
        [orgId, name, JSON.stringify(payload)],
      );
      await admin.setOrg(null);
    },
    setCardArchived: async (archived) => {
      await admin.setOrg(orgId);
      await admin.query(`UPDATE work.cards SET archived_at = $1 WHERE id = $2`, [
        archived ? new Date().toISOString() : null,
        cardId,
      ]);
      await admin.setOrg(null);
    },
  };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  /* Children before parents — the same ordering tenancy-seed.ts documents.
     Dispatch rows reference outbox rows, so they go first. */
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
    (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM search.documents WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.comments WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.pages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM docs.spaces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM chat.messages WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM chat.channels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.card_comments WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-search-relay-test',
  });
  initializeSearchDatabase({
    url: 'postgresql://taskflow_search:search-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-search-relay-test',
  });

  provider = new PostgresSearchProvider();
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.end();
});

async function documentRows(
  orgId: OrgId,
): Promise<
  {
    entityType: string;
    entityId: string;
    title: string | null;
    body: string | null;
    archived: boolean;
  }[]
> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        entityType: schema.documents.entityType,
        entityId: schema.documents.entityId,
        title: schema.documents.title,
        body: schema.documents.body,
        archived: schema.documents.archived,
      })
      .from(schema.documents)
      .where(eq(schema.documents.orgId, orgId)),
  );
}

function filterOf(query: string) {
  const parsed = parse(query);
  if (!parsed.ok || parsed.filter === null) throw new Error(`bad query ${query}`);
  return parsed.filter;
}

describe('the indexer relay', () => {
  it('indexes cards, messages, pages and comments from their events', async () => {
    const fx = await scaffold('full');
    await fx.emit('card.created', {
      cardId: fx.cardId,
      boardId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
    });
    await fx.emit('message.sent', { messageId: fx.messageId, channelId: crypto.randomUUID() });
    await fx.emit('page.created', { pageId: fx.pageId, spaceId: crypto.randomUUID() });
    await fx.emit('comment.created', { commentId: fx.commentId, cardId: fx.cardId });
    await fx.emit('page.comment_created', { commentId: fx.pageCommentId, pageId: fx.pageId });

    /* `processed` is a GLOBAL claim count and the full suite runs parallel
       against one taskflow_test — other files' pending rows (a sweep test's
       card.updated) can legitimately be claimed in the same batch. The
       exact, race-free assertions are the org-scoped documents below. */
    const result = await drainSearchIndex(100);
    expect(result.processed).toBeGreaterThanOrEqual(5);

    const docs = await documentRows(fx.orgId);
    expect(docs).toHaveLength(5);

    const card = docs.find((row) => row.entityType === 'card');
    expect(card?.title).toBe('Deploy outage');
    /* The projection stores the FLATTENED text, never TipTap JSON — search
       never parses a document (migration 0045's own header). */
    expect(card?.body).toBe('investigate the outage');
    expect(card?.archived).toBe(false);

    const message = docs.find((row) => row.entityType === 'message');
    expect(message?.body).toBe('is anyone looking at the outage');

    const page = docs.find((row) => row.entityType === 'page');
    expect(page?.title).toBe('Outage runbook');
    /* Wave 2 indexes page TITLES only (§2.4) — body stays NULL. */
    expect(page?.body).toBeNull();

    expect(
      docs.some((row) => row.entityType === 'comment' && row.body === 'check the logs first'),
    ).toBe(true);
    expect(
      docs.some(
        (row) => row.entityType === 'comment' && row.body === 'runbook needs a rollback section',
      ),
    ).toBe(true);
  });

  it('redelivers idempotently — the unique key, not the claim, is the guarantee', async () => {
    const fx = await scaffold('idem');
    await fx.emit('card.created', { cardId: fx.cardId });

    await drainSearchIndexFully();
    await drainSearchIndexFully();

    const docs = await documentRows(fx.orgId);
    expect(docs.filter((row) => row.entityType === 'card')).toHaveLength(1);
  });

  it('marks the document archived when the source is archived, and restores it', async () => {
    const fx = await scaffold('archive');
    await fx.emit('card.created', { cardId: fx.cardId });
    await fx.setCardArchived(true);
    await fx.emit('card.archived', { cardId: fx.cardId, restored: false });
    await drainSearchIndex(100);

    let docs = await documentRows(fx.orgId);
    expect(docs.find((row) => row.entityType === 'card')?.archived).toBe(true);

    await fx.setCardArchived(false);
    await fx.emit('card.archived', { cardId: fx.cardId, restored: true });
    await drainSearchIndex(100);

    docs = await documentRows(fx.orgId);
    expect(docs.find((row) => row.entityType === 'card')?.archived).toBe(false);
  });

  it('deletes the document row when the source message is deleted', async () => {
    const fx = await scaffold('delete');
    await fx.emit('message.sent', { messageId: fx.messageId });
    await fx.emit('message.deleted', { messageId: fx.messageId });
    await drainSearchIndex(100);

    const docs = await documentRows(fx.orgId);
    expect(docs.some((row) => row.entityType === 'message')).toBe(false);
  });

  it('propagates channel archive to the channel message documents', async () => {
    const fx = await scaffold('channel');
    /* The scaffolded message already names the scaffolded channel — the
       archive propagation is a source-of-truth read over chat.messages. */
    await fx.emit('message.sent', { messageId: fx.messageId, channelId: fx.channelId });
    await fx.emit('channel.archived', { channelId: fx.channelId, restored: false });
    await drainSearchIndex(100);

    const docs = await documentRows(fx.orgId);
    expect(docs.find((row) => row.entityType === 'message')?.archived).toBe(true);
  });

  it('consumes an event whose source row is gone without erroring', async () => {
    const fx = await scaffold('missing');
    await fx.emit('card.created', { cardId: crypto.randomUUID() });

    const result = await drainSearchIndex(100);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.written).toBeGreaterThanOrEqual(1);
  });
});

describe('the search route through the Postgres provider', () => {
  it('finds a card by free text over the title||body concatenation', async () => {
    const fx = await scaffold('find');
    await fx.emit('card.created', { cardId: fx.cardId });
    await drainSearchIndex(100);

    const hits = await provider.search({
      orgId: fx.orgId,
      filter: filterOf('text contains "outage"'),
      orderBy: [],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.type).toBe('card');
    expect(hits[0]?.title).toBe('Deploy outage');
    expect(hits[0]?.snippet).toContain('outage');
  });

  it('finds a page by TITLE even though its body is NULL — the concatenation', async () => {
    const fx = await scaffold('titleonly');
    await fx.emit('page.created', { pageId: fx.pageId });
    await drainSearchIndex(100);

    const hits = await provider.search({
      orgId: fx.orgId,
      filter: filterOf('text contains "runbook"'),
      orderBy: [],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });

    expect(hits.some((hit) => hit.type === 'page' && hit.title === 'Outage runbook')).toBe(true);
  });

  it('orders by updated_at desc by default, and respects ORDER BY when given', async () => {
    const fx = await scaffold('order');
    await fx.emit('card.created', { cardId: fx.cardId });
    await fx.emit('message.sent', { messageId: fx.messageId });
    await fx.emit('page.created', { pageId: fx.pageId });
    await drainSearchIndex(100);

    const byUpdated = await provider.search({
      orgId: fx.orgId,
      filter: compare('type', 'in', ['card', 'message', 'page']),
      orderBy: [],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });
    expect(byUpdated).toHaveLength(3);
    const dates = byUpdated.map((hit) => hit.updatedAt);
    expect([...dates].sort().reverse()).toEqual(dates);

    const byTitle = await provider.search({
      orgId: fx.orgId,
      filter: compare('type', 'in', ['card', 'message', 'page']),
      orderBy: [{ field: 'title', direction: 'asc' }],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });
    /* NULL titles sort last in ASC — a message has no title — so the page
       (Outage runbook) and card (Deploy outage) lead, alphabetically. */
    expect(byTitle[0]?.title).toBe('Deploy outage');
    expect(byTitle[1]?.title).toBe('Outage runbook');
  });

  it('respects the archived filter', async () => {
    const fx = await scaffold('archfilter');
    await fx.emit('card.created', { cardId: fx.cardId });
    await fx.setCardArchived(true);
    await fx.emit('card.archived', { cardId: fx.cardId, restored: false });
    await drainSearchIndex(100);

    const live = await provider.search({
      orgId: fx.orgId,
      filter: filterOf('archived = false'),
      orderBy: [],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });
    expect(live).toHaveLength(0);

    const archived = await provider.search({
      orgId: fx.orgId,
      filter: filterOf('archived = true'),
      orderBy: [],
      viewerId: unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001'),
      limit: 50,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.type).toBe('card');
  });
});
