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
}

export type ProjectSummary = Wire<Outputs['projects']>[number];
export type BoardSummary = Wire<Outputs['boards']>[number];
export type ListSummary = Wire<Outputs['lists']>[number];
export type CardSummary = Wire<Outputs['cards']>[number];
export type CardDetail = Wire<Outputs['card']>;

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

export function projectsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.projects(orgId),
    /* `includeArchived` is left at its default rather than passed as `false`.
       The default lives in the route's Zod schema, and restating it here is a
       second place for it to be wrong. */
    queryFn: async () => wire(await api.work.projects.list.query({})),
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

export function cardsQuery(orgId: string, boardId: BoardId, filter: FilterNode | null) {
  return queryOptions({
    queryKey: keys.cards(orgId, boardId, filterKey(filter)),
    queryFn: async () => wire(await api.work.cards.list.query({ boardId, filter })),
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
