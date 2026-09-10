import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { Segmented, Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { activeSprintsQuery, myCardsQuery } from './api.js';
import { ListView } from './list-view.js';

/**
 * My Tasks / Home (`ai/phase-3.5-work-ux.md` §6) — the one screen that is not
 * scoped to a project or a board.
 *
 * Reuses `ListView` exactly as the board's list mode does, grouped by due
 * date and nothing else: the spec fixes the grouping here rather than
 * offering the full board control set, because "what is on my plate, soonest
 * first" is the one question this page exists to answer. `lists`, `statuses`
 * and `people` are empty — `groupCards` only reads them for the list, status
 * and assignee groupings, none of which this page uses.
 *
 * Opening a card has to carry its BOARD, unlike the board page where every
 * card already shares one — `cards.mine` returns cards from however many
 * boards the caller can reach, so the id is looked up per card rather than
 * assumed. It also has no `project` search param to hand over: the card
 * detail panel already renders correctly without one (see `board-page.tsx`
 * on a board reached with no `?project=`), just without the labels and
 * custom-fields sections that need it.
 */

const SPRINT_SCOPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'sprint', label: 'This sprint' },
  { value: 'backlog', label: 'Backlog' },
] as const satisfies readonly { value: 'all' | 'sprint' | 'backlog'; label: string }[];

export function HomePage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();

  const cards = useQuery(myCardsQuery(orgId));
  /* The running sprints, so "this sprint" can mean something on a page that
     spans every board (10.6 D5). Cheap and usually cached — the sidebar runs
     the same query. */
  const activeSprints = useQuery({ ...activeSprintsQuery(orgId), enabled: orgId !== '' });
  const [scope, setScope] = useState<'all' | 'sprint' | 'backlog'>('all');

  if (cards.isPending) {
    return (
      <div aria-busy="true" className="mx-auto max-w-7xl space-y-2 px-6 py-8">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (cards.isError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <ErrorView error={cards.error} title="Could not load your tasks" />
      </div>
    );
  }

  const boardOf = new Map(cards.data.map((card) => [card.cardId, card.boardId]));

  /* "In a running sprint" is membership of ANY active sprint, not one chosen
     sprint: My Tasks spans every board in the org, so a person assigned work
     in two teams' sprints is in both, and asking them to pick one first would
     hide half their week. `sprintId` rides the card summary already (0054's
     slice 3), so this is a client-side narrowing of a list already in hand —
     no second query, and no server-side variant of `listMyCards` to keep in
     step with this one. */
  const runningSprintIds = new Set((activeSprints.data ?? []).map((sprint) => sprint.sprintId));
  const visible =
    scope === 'all'
      ? cards.data
      : scope === 'backlog'
        ? cards.data.filter((card) => card.sprintId === null)
        : cards.data.filter(
            (card) => card.sprintId !== null && runningSprintIds.has(card.sprintId),
          );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One column for the whole page — the header and the list share the same
          max-width and horizontal padding, so the title, the filter and the
          rows all start on the same edge. The header used to span the full
          window while the list was a centered max-w-4xl, which put the title at
          the far left and the rows ~170px in with nothing explaining the jump. */}
      <div className="mx-auto w-full max-w-7xl shrink-0 px-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink">My tasks</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
              {visible.length} {visible.length === 1 ? 'card' : 'cards'}
              {scope === 'all'
                ? ' assigned to you, across every board.'
                : scope === 'sprint'
                  ? ' assigned to you in a running sprint.'
                  : ' assigned to you and not in any sprint.'}
            </p>
          </div>

          {/* Offered only when a sprint is actually running. A team that does
              not use sprints would otherwise get two filters that both mean
              "everything" and one that is always empty. */}
          {runningSprintIds.size > 0 && (
            <Segmented
              value={scope}
              onChange={setScope}
              options={SPRINT_SCOPE_OPTIONS}
              aria-label="Filter by sprint"
            />
          )}
        </div>
      </div>

      <ListView
        lists={[]}
        cards={visible}
        statuses={[]}
        people={[]}
        groupBy="due"
        sortBy="due"
        emptyDescription="Nothing is assigned to you right now."
        onOpenCard={(cardId) => {
          const boardId = boardOf.get(cardId);
          if (boardId === undefined) return;
          void navigate({
            to: '/boards/$boardId',
            params: { boardId: boardId as BoardId },
            search: { view: 'board', card: cardId },
          });
        }}
      />
    </div>
  );
}
