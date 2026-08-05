import { useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { CardId, ProjectId } from '@taskflow/contracts';
import type { FilterNode } from '@taskflow/filter';
import { useSession } from '../../lib/session.js';
import { Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useMembers } from '../org/use-members.js';
import { cardsQuery, listsQuery, statusesQuery } from './api.js';
import { BoardView } from './board-view.js';
import { TableView } from './table-view.js';
import { ListView } from './list-view.js';
import { FilterBuilder } from './filter/filter-builder.js';
import { ViewTabs } from './view-tabs.js';
import { BulkBar } from './bulk-bar.js';
import {
  EMPTY_SELECTION,
  pruneSelection,
  selectRange,
  toggle,
  type SelectionState,
} from './selection.js';
import { CardDetailPanel } from './detail/card-detail-panel.js';
import { ShareBoardDialog } from './share-board.js';
import { ArchivedCardsDialog } from './archived-cards-dialog.js';
import { GROUP_BY_OPTIONS, SORT_BY_OPTIONS, type GroupBy, type SortBy } from './grouping.js';
import { cn } from '../../lib/cn.js';

const GROUP_BY_LABEL: Readonly<Record<GroupBy, string>> = {
  list: 'List',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  due: 'Due date',
};

const SORT_BY_LABEL: Readonly<Record<SortBy, string>> = {
  manual: 'Manual',
  title: 'Title',
  due: 'Due date',
  priority: 'Priority',
};

/**
 * A board, in either of its two views (§10.4).
 *
 * Kanban and table READ THE SAME QUERY. That is the point of the arrangement:
 * `cardsQuery(orgId, boardId, filter)` is fetched once here and handed to
 * whichever view is showing, so switching views is instant and — more
 * importantly — the two can never disagree about which cards match a filter.
 * Two views each fetching their own would eventually differ in the parameters
 * they send, and the difference would look like a bug in the filter.
 *
 * View, filter and open card all live in the URL (§10.5), so a board with a
 * filter applied and a card open is one link.
 */

export function BoardPage() {
  const { boardId } = useParams({ from: '/boards/$boardId' });
  const search = useSearch({ from: '/boards/$boardId' });
  const navigate = useNavigate({ from: '/boards/$boardId' });
  const orgId = useSession((state) => state.orgId) ?? '';

  const filter: FilterNode | null = search.filter ?? null;
  const view = search.view ?? 'board';
  const groupBy = search.groupBy ?? 'list';
  const sortBy = search.sortBy ?? 'manual';
  const projectId = search.project ?? null;

  const lists = useQuery(listsQuery(orgId, boardId));
  const cards = useQuery(cardsQuery(orgId, boardId, filter));
  const { people: members, peopleOf } = useMembers();
  const people = peopleOf(members.map((member) => member.userId));
  /* Loading is not gated on this — a board grouped by status while the
     vocabulary is still in flight just shows the "No status" bucket for a
     moment, which is the same graceful-degradation `useMembers` already
     accepts for avatars. `projectId` can be missing on a board reached by a
     pasted URL with no `?project=`; the query simply does not fire, and
     grouping by status shows nothing to group by rather than throwing. */
  const statuses = useQuery({
    ...statusesQuery(orgId, projectId ?? ('' as ProjectId)),
    enabled: projectId !== null,
  });

  const setSearch = (next: Partial<typeof search>) => {
    void navigate({ search: (previous) => ({ ...previous, ...next }) });
  };

  /* Selection is genuinely client-only state with no server representation, so
     it lives here rather than in the URL: a link that carried a selection would
     restore a bulk action someone had half-composed, and §10.5 keeps the URL
     for what is being LOOKED at, not what is being done to it.

     Local to this page rather than Zustand for the same reason — it must not
     survive navigating to another board, and a store would make that survival
     the default. */
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);

  if (lists.isPending || cards.isPending) {
    /* Columns, not a spinner. The board's shape is known before its contents
       are, so the layout can exist while the cards are still in flight — which
       means nothing jumps into place when they land. */
    return (
      <div aria-busy="true" className="flex h-full items-start gap-3 p-3">
        {[0, 1, 2].map((column) => (
          <div key={column} className="w-72 shrink-0 space-y-2 rounded-card bg-surface-sunken p-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (lists.isError || cards.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorView error={lists.error ?? cards.error} title="Could not load this board" />
      </div>
    );
  }

  /* No archived filter here: `lists.list` excludes archived and deleted lists in
     its WHERE clause and does not return the column, so a client-side filter
     would be a second, weaker copy of a rule that is already enforced. */
  const liveLists = lists.data;

  /* Pruned against what is actually on screen. A filter narrowed after cards
     were picked would otherwise leave the bulk bar counting — and acting on —
     rows the user can no longer see. `pruneSelection` returns the same object
     when nothing changed, so reading it during render does not loop. */
  const visibleIds = cards.data.map((card) => card.cardId);
  const visibleSelection = pruneSelection(selection, visibleIds);

  return (
    <div className="flex h-full min-h-0">
      {/* `relative` so the bulk bar can float against the board column rather
          than the viewport — it must sit above the cards and below any dialog,
          and anchoring it to the viewport would put it over the sidebar. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-2">
          <ViewToggle
            value={view}
            onChange={(next) => {
              setSearch({ view: next });
            }}
          />

          {/* Selecting a view WRITES the four URL params rather than becoming
              state of its own. The URL stays the single description of what is
              on screen, so a pasted link and the highlighted tab can never
              disagree — see view-tabs.tsx. */}
          <ViewTabs
            orgId={orgId}
            boardId={boardId}
            current={{ type: view, groupBy, sortBy, filter }}
            onApply={(arrangement) => {
              setSearch({
                view: arrangement.type,
                groupBy: arrangement.groupBy,
                sortBy: arrangement.sortBy,
                filter: arrangement.filter ?? undefined,
              });
            }}
          />

          <FilterBuilder
            orgId={orgId}
            projectId={projectId}
            value={filter}
            onChange={(next) => {
              setSearch({ filter: next ?? undefined });
            }}
          />

          {/* Grouping and sorting are view SETTINGS (§5.6) — meaningless for
              the table, which has its own columns, so they only render for
              board and list. */}
          {view !== 'table' && (
            <>
              <GroupBySelect
                value={groupBy}
                onChange={(next) => {
                  setSearch({ groupBy: next });
                }}
              />
              <SortBySelect
                value={sortBy}
                onChange={(next) => {
                  setSearch({ sortBy: next });
                }}
              />
            </>
          )}

          <span className="ml-auto text-xs text-ink-faint">
            {cards.data.length} {cards.data.length === 1 ? 'card' : 'cards'}
            {filter !== null && ' matching'}
          </span>

          <ArchivedCardsDialog orgId={orgId} boardId={boardId} />
          <ShareBoardDialog orgId={orgId} boardId={boardId} />
        </div>

        {view === 'board' && (
          <BoardView
            orgId={orgId}
            boardId={boardId}
            lists={liveLists}
            cards={cards.data}
            statuses={statuses.data ?? []}
            people={people}
            groupBy={groupBy}
            sortBy={sortBy}
            selected={visibleSelection.selected}
            onToggleSelect={(cardId, extend) => {
              setSelection((previous) =>
                extend
                  ? selectRange(previous, cardId, visibleIds)
                  : toggle(previous, cardId),
              );
            }}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
          />
        )}

        {view === 'list' && (
          <ListView
            lists={liveLists}
            cards={cards.data}
            statuses={statuses.data ?? []}
            people={people}
            groupBy={groupBy}
            sortBy={sortBy}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
          />
        )}

        {view === 'table' && (
          <TableView
            orgId={orgId}
            boardId={boardId}
            lists={liveLists}
            cards={cards.data}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
          />
        )}

        <BulkBar
          orgId={orgId}
          boardId={boardId}
          selected={visibleSelection.selected}
          statuses={statuses.data ?? []}
          people={people}
          onClear={() => {
            setSelection(EMPTY_SELECTION);
          }}
        />
      </div>

      {search.card !== undefined && (
        <CardDetailPanel
          orgId={orgId}
          boardId={boardId}
          cardId={search.card}
          projectId={search.project ?? null}
          onClose={() => {
            setSearch({ card: undefined });
          }}
        />
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  readonly value: 'board' | 'table' | 'list';
  readonly onChange: (value: 'board' | 'table' | 'list') => void;
}) {
  return (
    <div className="inline-flex rounded border border-line" role="group" aria-label="View">
      {(['board', 'list', 'table'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => {
            onChange(mode);
          }}
          className={cn(
            'px-2.5 py-1 text-xs capitalize first:rounded-l last:rounded-r',
            value === mode ? 'bg-accent text-accent-ink' : 'text-ink-muted hover:bg-surface-hover',
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function GroupBySelect({
  value,
  onChange,
}: {
  readonly value: GroupBy;
  readonly onChange: (value: GroupBy) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
      Group by
      <select
        aria-label="Group by"
        value={value}
        onChange={(event) => {
          onChange(event.target.value as GroupBy);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        {GROUP_BY_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {GROUP_BY_LABEL[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function SortBySelect({
  value,
  onChange,
}: {
  readonly value: SortBy;
  readonly onChange: (value: SortBy) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
      Sort by
      <select
        aria-label="Sort by"
        value={value}
        onChange={(event) => {
          onChange(event.target.value as SortBy);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        {SORT_BY_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {SORT_BY_LABEL[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
