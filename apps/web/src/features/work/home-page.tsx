import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { myCardsQuery } from './api.js';
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

export function HomePage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();

  const cards = useQuery(myCardsQuery(orgId));

  if (cards.isPending) {
    return (
      <div aria-busy="true" className="mx-auto max-w-4xl space-y-2 p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (cards.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorView error={cards.error} title="Could not load your tasks" />
      </div>
    );
  }

  const boardOf = new Map(cards.data.map((card) => [card.cardId, card.boardId]));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <h1 className="text-sm font-semibold text-ink">My tasks</h1>
        <p className="text-xs text-ink-faint">
          {cards.data.length} {cards.data.length === 1 ? 'card' : 'cards'} assigned to you, across
          every board.
        </p>
      </div>

      <ListView
        lists={[]}
        cards={cards.data}
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
