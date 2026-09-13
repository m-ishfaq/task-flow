import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import type { BoardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { PageContainer, PageHeader, Segmented, Skeleton } from '../../components/primitives.js';
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
      <PageContainer maxWidth="2xl">
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </PageContainer>
    );
  }

  if (cards.isError) {
    return (
      <PageContainer maxWidth="2xl">
        <ErrorView error={cards.error} title="Could not load your tasks" />
      </PageContainer>
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

  const description = `${String(visible.length)} ${visible.length === 1 ? 'card' : 'cards'}${
    scope === 'all'
      ? ' assigned to you, across every board.'
      : scope === 'sprint'
        ? ' assigned to you in a running sprint.'
        : ' assigned to you and not in any sprint.'
  }`;

  /* The empty state used to be one fixed sentence ("Nothing is assigned to
     you right now") regardless of WHY the list is empty — which is honest
     when `cards.data` itself is empty, and actively misleading the moment a
     scope filter (This sprint / Backlog) hides tasks that genuinely exist
     under "All". The two cases get different wording so the second one
     tells someone how to see what they know is there. */
  const emptyTitle = cards.data.length === 0 ? 'No tasks assigned to you' : 'Nothing in this view';
  const emptyDescription =
    cards.data.length === 0
      ? "When you're assigned a card on any board, it will show up here."
      : scope === 'sprint'
        ? 'None of your assigned cards are in a running sprint. Switch to "All" to see the rest.'
        : 'None of your assigned cards are outside a sprint. Switch to "All" to see the rest.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One column for the whole page — the header and the list share the same
          max-width and horizontal padding (`PageContainer`'s own "2xl" tier,
          matching `list-view.tsx`'s own hardcoded `max-w-7xl px-6`), so the
          title, the filter and the rows all start on the same edge. The
          header used to span the full window while the list was a centered
          max-w-4xl, which put the title at the far left and the rows ~170px
          in with nothing explaining the jump. */}
      <PageContainer maxWidth="2xl" className="shrink-0">
        <PageHeader
          title="My tasks"
          description={description}
          /* A plain ternary is fine here, unlike `PageHeader`'s own
             `description?: string | undefined` above — `ReactNode`'s type
             already includes `undefined` as one of its members, so an
             `actions?: ReactNode` prop tolerates an explicit `undefined`
             under `exactOptionalPropertyTypes` with no conditional-spread
             dance needed. Offered only when a sprint is actually running —
             a team that does not use sprints would otherwise get two
             filters that both mean "everything" and one that is always
             empty. */
          actions={
            runningSprintIds.size > 0 ? (
              <Segmented
                value={scope}
                onChange={setScope}
                options={SPRINT_SCOPE_OPTIONS}
                aria-label="Filter by sprint"
              />
            ) : undefined
          }
        />
      </PageContainer>

      <ListView
        lists={[]}
        cards={visible}
        statuses={[]}
        people={[]}
        groupBy="due"
        sortBy="due"
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        emptyIcon={<Inbox aria-hidden="true" className="size-6" strokeWidth={1.75} />}
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
