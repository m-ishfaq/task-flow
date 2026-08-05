import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { FilterNode } from '@taskflow/filter';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';

/**
 * Every Work read, in one place.
 *
 * These are `queryOptions` rather than hooks so the same definition serves a
 * component, a route loader, and a prefetch — a hook can only be called from
 * one of those, and duplicating the key between them is how a mutation
 * invalidates something nobody is watching.
 *
 * `wire()` on every result: the API types say `Date` and the wire carries a
 * string, because no transformer is configured. See lib/wire.ts.
 */

interface Outputs {
  projects: Awaited<ReturnType<typeof api.work.projects.list.query>>;
  boards: Awaited<ReturnType<typeof api.work.boards.list.query>>;
  lists: Awaited<ReturnType<typeof api.work.lists.list.query>>;
  cards: Awaited<ReturnType<typeof api.work.cards.list.query>>;
  card: Awaited<ReturnType<typeof api.work.cards.get.query>>;
  checklists: Awaited<ReturnType<typeof api.work.checklists.list.query>>;
  comments: Awaited<ReturnType<typeof api.work.comments.list.query>>;
  cardLabels: Awaited<ReturnType<typeof api.work.labels.onCard.query>>;
  statuses: Awaited<ReturnType<typeof api.work.statuses.list.query>>;
  views: Awaited<ReturnType<typeof api.work.views.list.query>>;
}

export type ProjectSummary = Wire<Outputs['projects']>[number];
export type BoardSummary = Wire<Outputs['boards']>[number];
export type ListSummary = Wire<Outputs['lists']>[number];
export type CardSummary = Wire<Outputs['cards']>[number];
export type CardDetail = Wire<Outputs['card']>;
export type Checklist = Wire<Outputs['checklists']>[number];
export type Comment = Wire<Outputs['comments']>[number];
export type CardLabel = Wire<Outputs['cardLabels']>[number];
export type Status = Wire<Outputs['statuses']>[number];
export type SavedView = Wire<Outputs['views']>[number];
/** `CardSummary['priority']` on its own — used anywhere a picker needs just the enum. */
export type Priority = NonNullable<CardSummary['priority']>;

/**
 * The cache key for a filtered card query.
 *
 * A stable string rather than the tree itself: React Query hashes keys
 * structurally, and two filters that differ only in the ORDER of their children
 * mean the same thing but would hash differently, so the board would refetch
 * every time the builder re-rendered its chips. Serializing keeps that decision
 * in one function instead of implicitly in the shape of every caller's object.
 */
export function filterKey(filter: FilterNode | null): string {
  return filter === null ? 'all' : JSON.stringify(filter);
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

/**
 * The org's projects.
 *
 * `includeArchived` is part of the query KEY as well as the request: the two
 * responses are different lists, and caching them under one key means opening
 * the archived view serves the live list from cache and then replaces it —
 * a flash of the wrong answer, and a stale one if the refetch is deduped.
 */
export function projectsQuery(orgId: string, includeArchived = false) {
  return queryOptions({
    queryKey: keys.projectList(orgId, includeArchived),
    /* Only sent when true. The default lives in the route's Zod schema, and
       restating `false` here is a second place for it to be wrong. */
    queryFn: async () =>
      wire(await api.work.projects.list.query(includeArchived ? { includeArchived: true } : {})),
  });
}

export function boardsQuery(orgId: string, projectId: ProjectId) {
  return queryOptions({
    queryKey: keys.boards(orgId, projectId),
    queryFn: async () => wire(await api.work.boards.list.query({ projectId })),
  });
}

export function listsQuery(orgId: string, boardId: BoardId) {
  return queryOptions({
    queryKey: keys.lists(orgId, boardId),
    queryFn: async () => wire(await api.work.lists.list.query({ boardId })),
  });
}

/**
 * Archived columns — the ones `listsQuery` above will never return.
 *
 * `archivedOnly` REPLACES the live-only WHERE rather than widening it (see
 * list.service.ts), so unlike `archivedCardsQuery` there is nothing to filter
 * client-side. The key nests UNDER `keys.lists` so archiving or restoring a
 * column, which already invalidates that family, refreshes this list too with
 * no second invalidation to remember.
 */
export function archivedListsQuery(orgId: string, boardId: BoardId) {
  return queryOptions({
    queryKey: [...keys.lists(orgId, boardId), 'archived'] as const,
    queryFn: async () => wire(await api.work.lists.list.query({ boardId, archivedOnly: true })),
  });
}

/**
 * The board's saved views: every shared one, plus the caller's own private ones.
 *
 * The server decides which — a private view belongs to its author and the read
 * filters on `created_by`. Nothing here re-derives that, per §8.2.
 */
export function viewsQuery(orgId: string, boardId: BoardId) {
  return queryOptions({
    queryKey: keys.views(orgId, boardId),
    queryFn: async () => wire(await api.work.views.list.query({ boardId })),
  });
}

export function cardsQuery(orgId: string, boardId: BoardId, filter: FilterNode | null) {
  return queryOptions({
    queryKey: keys.cards(orgId, boardId, filterKey(filter)),
    queryFn: async () => wire(await api.work.cards.list.query({ boardId, filter })),
  });
}

/**
 * Archived cards on a board — the ones `cardsQuery` above will never return.
 *
 * `includeArchived: true` widens `cards.list` past its hardcoded live-only
 * WHERE (see card.service.ts); it does not narrow to archived-only, so the
 * caller filters for `archivedAt !== null`, same as `projects-page.tsx` does
 * the opposite filter for live projects. The synthetic `'archived'` filter
 * key keeps this in its own cache entry while staying inside
 * `keys.cardsOfBoard`, so archiving or restoring a card — which already
 * invalidates the whole `cardsOfBoard` family — refreshes this list too with
 * no separate invalidation call to remember.
 */
export function archivedCardsQuery(orgId: string, boardId: BoardId) {
  return queryOptions({
    queryKey: keys.cards(orgId, boardId, 'archived'),
    queryFn: async () => {
      const rows = wire(
        await api.work.cards.list.query({ boardId, filter: null, includeArchived: true }),
      );
      return rows.filter((card) => card.archivedAt !== null);
    },
  });
}

export function cardQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.card(orgId, cardId),
    queryFn: async () => wire(await api.work.cards.get.query({ cardId })),
  });
}

export function labelsQuery(orgId: string, projectId: ProjectId) {
  return queryOptions({
    queryKey: keys.labels(orgId, projectId),
    queryFn: async () => wire(await api.work.labels.list.query({ projectId })),
  });
}

export function cardLabelsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.cardLabels(orgId, cardId),
    queryFn: async () => wire(await api.work.labels.onCard.query({ cardId })),
  });
}

export function statusesQuery(orgId: string, projectId: ProjectId) {
  return queryOptions({
    queryKey: keys.statuses(orgId, projectId),
    queryFn: async () => wire(await api.work.statuses.list.query({ projectId })),
  });
}

export function fieldsQuery(orgId: string, projectId: ProjectId) {
  return queryOptions({
    queryKey: keys.fields(orgId, projectId),
    queryFn: async () => wire(await api.work.fields.list.query({ projectId })),
  });
}

export function cardFieldsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.cardFields(orgId, cardId),
    queryFn: async () => wire(await api.work.fields.onCard.query({ cardId })),
  });
}

export function checklistsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.checklists(orgId, cardId),
    queryFn: async () => wire(await api.work.checklists.list.query({ cardId })),
  });
}

export function commentsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.comments(orgId, cardId),
    queryFn: async () => wire(await api.work.comments.list.query({ cardId })),
  });
}

export function attachmentsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.attachments(orgId, cardId),
    queryFn: async () => wire(await api.work.attachments.list.query({ cardId })),
  });
}

/* -------------------------------------------------------------------------- *
 * Optimistic cache edits
 * -------------------------------------------------------------------------- */

/**
 * Rewrites every cached card list for a board, whatever filter it carries.
 *
 * A board can hold several `cards` entries at once — the unfiltered view plus
 * one per filter the user has visited, since `filterKey` puts the filter in the
 * key. A card that moved has moved in all of them, so an optimistic patch that
 * only touched the currently-visible one would leave the others wrong and they
 * would render, from cache, the moment the filter was cleared.
 *
 * The callback returns a NEW array. Mutating the cached one in place would skip
 * React Query's reference check and the board would not re-render, which is the
 * one failure that makes an optimistic update look like no update at all.
 */
export function patchBoardCards(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  fn: (cards: readonly CardSummary[]) => readonly CardSummary[],
): void {
  const entries = client.getQueriesData<readonly CardSummary[]>({
    queryKey: keys.cardsOfBoard(orgId, boardId),
  });

  for (const [key, cards] of entries) {
    if (cards !== undefined) client.setQueryData(key, fn(cards));
  }
}

/** The same, for one card's detail entry. A no-op when it is not cached. */
export function patchCardDetail(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  fn: (card: CardDetail) => CardDetail,
): void {
  const current = client.getQueryData<CardDetail>(keys.card(orgId, cardId));
  if (current !== undefined) client.setQueryData(keys.card(orgId, cardId), fn(current));
}

/**
 * Adjusts a card's checklist counters everywhere they are rendered.
 *
 * The counters live on the CARD row, not on the checklist, because the board
 * tile shows `☑ 2/5` without loading any checklists. So ticking an item in the
 * detail panel has to move a number the panel is not displaying — and forgetting
 * it leaves a badge that is wrong until the next full refetch, which is the
 * failure `counters.ts` recomputes server-side specifically to avoid. An
 * optimistic update that skipped it would reintroduce the drift on the client.
 *
 * The deltas are applied rather than recomputed because the caller knows exactly
 * what changed and the cache may not hold the checklists at all.
 */
export function patchChecklistCounters(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  cardId: CardId,
  delta: { readonly done: number; readonly total: number },
): void {
  patchBoardCards(client, orgId, boardId, (cards) =>
    cards.map((card) =>
      card.cardId === cardId
        ? {
            ...card,
            /* Clamped. A double-click that fires two toggles before either
               settles would otherwise show `-1/5`, and a negative count reads as
               a bug in a way that a momentarily stale one does not. */
            checklistDone: Math.max(0, card.checklistDone + delta.done),
            checklistTotal: Math.max(0, card.checklistTotal + delta.total),
          }
        : card,
    ),
  );
}

/** Rewrites the cached checklists for a card. A no-op when not cached. */
export function patchChecklists(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  fn: (checklists: readonly Checklist[]) => readonly Checklist[],
): void {
  const key = keys.checklists(orgId, cardId);
  const current = client.getQueryData<readonly Checklist[]>(key);
  if (current !== undefined) client.setQueryData(key, fn(current));
}

/**
 * The same, for a card's comments.
 *
 * Unlike the checklist helpers this one is also used to INSERT, so it is written
 * to seed an empty array rather than no-op when the key is cold: the panel that
 * posts a comment is the panel that renders them, so the query is always
 * present in practice — but a rollback removes an entry it did not find (see
 * `optimistic.ts`), and seeding here keeps that path honest rather than relying
 * on it never being taken.
 */
export function patchComments(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  fn: (comments: readonly Comment[]) => readonly Comment[],
): void {
  const key = keys.comments(orgId, cardId);
  const current = client.getQueryData<readonly Comment[]>(key);
  if (current !== undefined) client.setQueryData(key, fn(current));
}

/**
 * Moves a card's comment counter everywhere it is rendered.
 *
 * Same reasoning as `patchChecklistCounters`, and the same trap: `commentCount`
 * lives on the CARD row and is drawn as `💬 3` on the board tile, which the
 * detail panel is covering at the moment someone posts. Before this existed the
 * comment mutations invalidated only `keys.comments`, so the badge stayed at its
 * old number until something else refetched the board — and a stale badge looks
 * exactly like a correct one.
 */
export function patchCommentCount(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  cardId: CardId,
  delta: number,
): void {
  patchBoardCards(client, orgId, boardId, (cards) =>
    cards.map((card) =>
      card.cardId === cardId
        ? { ...card, commentCount: Math.max(0, card.commentCount + delta) }
        : card,
    ),
  );
}

/** Rewrites the labels cached against one card. A no-op when not cached. */
export function patchCardLabels(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  fn: (labels: readonly CardLabel[]) => readonly CardLabel[],
): void {
  const key = keys.cardLabels(orgId, cardId);
  const current = client.getQueryData<readonly CardLabel[]>(key);
  if (current !== undefined) client.setQueryData(key, fn(current));
}

/** Rewrites a board's cached list order. A no-op when not cached. */
export function patchLists(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  fn: (lists: readonly ListSummary[]) => readonly ListSummary[],
): void {
  const key = keys.lists(orgId, boardId);
  const current = client.getQueryData<readonly ListSummary[]>(key);
  if (current !== undefined) client.setQueryData(key, fn(current));
}

/* -------------------------------------------------------------------------- *
 * Invalidation
 * -------------------------------------------------------------------------- */

/**
 * What changes when a card changes.
 *
 * Centralized because the answer is not obvious and is wrong by omission: a
 * comment changes the card's `commentCount`, which is rendered on the BOARD, so
 * posting one from the detail panel has to invalidate the board query too.
 * Leaving that out produces a badge that is correct until the next full reload
 * — and a stale badge looks exactly like a correct one (which is the same
 * reasoning the API's `counters.ts` gives for recomputing rather than
 * incrementing).
 */
export async function invalidateCard(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  boardId: BoardId,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.card(orgId, cardId) }),
    client.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
  ]);
}

/** Everything derived from a board's structure. */
export async function invalidateBoard(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.lists(orgId, boardId) }),
    client.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
  ]);
}
