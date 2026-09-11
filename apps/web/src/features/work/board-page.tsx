import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { CardId, ProjectId } from '@taskflow/contracts';
import type { FilterNode } from '@taskflow/filter';
import { useSession } from '../../lib/session.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { Segmented, Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useMembers } from '../org/use-members.js';
import { boardsQuery, cardsQuery, listsQuery, projectsQuery, statusesQuery } from './api.js';
import { SprintPicker } from './sprints.js';
import { filterCardsBySprint, type SprintFilter } from './sprint-filter.js';
import { useBoardRoom } from './use-board-room.js';
import { BoardView } from './board-view.js';
import { TableView } from './table-view.js';
import { ListView } from './list-view.js';
import { CalendarView } from './calendar-view.js';
import { FilterBuilder } from './filter/filter-builder.js';
import { ViewTabs } from './view-tabs.js';
import { BulkBar } from './bulk-bar.js';
import { BoardInsightsPanel } from '../analytics/board-insights-panel.js';
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
import { ImportExportDialog } from './import-export-dialog.js';
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
 *
 * ## The toolbar collapses on narrow web screens only
 *
 * The header row (view tabs, saved views, filter/sprint, group/sort, share)
 * is one `flex-wrap` row that reads fine at desktop width and, below `md:`,
 * wraps into five or six stacked lines before any card is visible — a real
 * usability complaint on a phone browser, not a design choice worth keeping.
 * `useIsDesktop()` (the same 768px `md:` breakpoint `calendar-view.tsx`
 * already coordinates its own responsive swap against) gates a purely
 * cosmetic disclosure: at `md:` and above the full row always renders,
 * exactly as before this change, and no toggle appears at all. Below it, a
 * compact bar (current view name plus a "Tools" toggle) is what's always
 * visible, and the full row — completely unchanged, same components, same
 * props — only renders once expanded. No behavior, permission, or data
 * changed by this; `toolbarExpanded` is pure, unpersisted client state, the
 * same "no server representation" reasoning `selection` below already gets.
 */

export function BoardPage() {
  const { boardId } = useParams({ from: '/boards/$boardId' });
  const search = useSearch({ from: '/boards/$boardId' });
  const navigate = useNavigate({ from: '/boards/$boardId' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const selfId = useSession((state) => state.userId);

  const filter: FilterNode | null = search.filter ?? null;
  const view = search.view ?? 'board';
  const groupBy = search.groupBy ?? 'list';
  const sortBy = search.sortBy ?? 'manual';
  const sprint: SprintFilter = search.sprint ?? null;

  const lists = useQuery(listsQuery(orgId, boardId));
  const cards = useQuery(cardsQuery(orgId, boardId, filter));

  /* The URL's `project` is the normal source (every board link sends it), but
     a board reached from My Tasks or a pasted link may not carry it. Every
     card on the board knows its project, so the first card is the fallback —
     the URL is left untouched; this only decides what vocabulary to QUERY.
     The query gating below flips itself on the moment a card lands. Cast
     because the fallback comes off the wire un-branded. */
  const projectId = (search.project ?? cards.data?.[0]?.projectId ?? null) as ProjectId | null;

  /* `boards.list`/`projects.list` already return per-row `capabilities.update`
     (`board:update`/`project:update`) — `projects-page.tsx` and
     `project-settings-page.tsx` already read them for their own controls, but
     this page never fetched either, so every list/sprint/import management
     control below rendered unconditionally and let a Member's attempt come
     back FORBIDDEN (Phase 15 §1's sweep). `enabled: projectId !== null`
     matches the same gating `statuses` above already uses. */
  const boards = useQuery({
    ...boardsQuery(orgId, projectId ?? ('' as ProjectId)),
    enabled: projectId !== null,
  });
  const canManageBoard =
    boards.data?.find((board) => board.boardId === boardId)?.capabilities.update ?? false;

  const projects = useQuery(projectsQuery(orgId));
  const canManageProject =
    projects.data?.find((project) => project.projectId === projectId)?.capabilities.update ?? false;

  /* Realtime spine (ai/phase-4-realtime.md §5, §9): joins this board's room
     and patches/invalidates the queries above live as the full Wave 2 event
     catalog arrives from other clients, and reports who else has this room
     open. Called unconditionally, before either loading state below can
     return early — Rules of Hooks — which is also correct for what it does:
     a board still loading its OWN queries can still join the room that will
     patch them the moment they land. */
  const { presence } = useBoardRoom(orgId, boardId);
  const { people: members, peopleOf } = useMembers();
  const people = peopleOf(members.map((member) => member.userId));
  /* Excludes the viewer themself — "who else is here" (§9), not a roster the
     viewer is already part of. */
  const othersPresent = peopleOf(presence.filter((userId) => userId !== selfId));
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

  /* Small-screen-only toolbar disclosure — see the component's own doc
     comment above. `isDesktop` decides whether the toggle exists at all;
     `toolbarExpanded` only matters when it does not. */
  const isDesktop = useIsDesktop();
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

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
        <ErrorView
          error={lists.error ?? cards.error}
          title="Could not load this board"
          onRetry={() => {
            // Whichever query actually failed — the request almost never
            // reached the server at all (Design Bible §17's own framing for
            // this exact state), so a retry is just asking React Query to
            // try both again rather than diagnosing which one to target.
            if (lists.isError) void lists.refetch();
            if (cards.isError) void cards.refetch();
          }}
        />
      </div>
    );
  }

  /* No archived filter here: `lists.list` excludes archived and deleted lists in
     its WHERE clause and does not return the column, so a client-side filter
     would be a second, weaker copy of a rule that is already enforced. */
  const liveLists = lists.data;

  /* The sprint dimension filters the SAME card query in the renderer — a
     sprint board is the board, filtered, and switching between All, Backlog
     and a sprint is instant (ai/phase-10.5-sprints.md). Selections and counts
     are pruned against the filtered list for the same reason the filter itself
     is: the bulk bar must never count rows the user cannot see. */
  const sprintCards = filterCardsBySprint(cards.data, sprint);
  const visibleIds = sprintCards.map((card) => card.cardId);
  const visibleSelection = pruneSelection(selection, visibleIds);

  return (
    <div className="flex h-full min-h-0">
      {/* `relative` so the bulk bar can float against the board column rather
          than the viewport — it must sit above the cards and below any dialog,
          and anchoring it to the viewport would put it over the sidebar. */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line/50 bg-surface-raised/80 backdrop-blur-sm">
          {/* Compact bar — small screens only (`isDesktop` false below `md:`).
              Always visible there regardless of `toolbarExpanded`, so there is
              always a way back to collapsing the full row again. Renders
              nothing at desktop width, where the full row below is always
              shown and this toggle would be redundant chrome. */}
          {!isDesktop && (
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="text-xs font-medium capitalize text-ink">{view}</span>
              <button
                type="button"
                aria-expanded={toolbarExpanded}
                aria-label={toolbarExpanded ? 'Hide board tools' : 'Show board tools'}
                onClick={() => {
                  setToolbarExpanded((previous) => !previous);
                }}
                className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-line/60 bg-surface-sunken/40 px-2.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Tools
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform duration-[var(--motion-fast)]',
                    toolbarExpanded && 'rotate-180',
                  )}
                />
              </button>
            </div>
          )}

          <div
            className={cn(
              'flex flex-wrap items-center gap-3 px-4 py-2.5',
              !isDesktop && (toolbarExpanded ? 'border-t border-line/50' : 'hidden'),
            )}
          >
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
              canManageBoard={canManageBoard}
            />

            <FilterBuilder
              orgId={orgId}
              projectId={projectId}
              value={filter}
              onChange={(next) => {
                setSearch({ filter: next ?? undefined });
              }}
            />

            {/* The sprint dimension — the picker writes `sprint=` and the
              manager panel lives behind it. Only when the project is known
              (same gating as the status vocabulary above). */}
            {projectId !== null && (
              <SprintPicker
                orgId={orgId}
                projectId={projectId}
                boardId={boardId}
                value={sprint}
                onChange={(next) => {
                  setSearch({ sprint: next ?? undefined });
                }}
                canManageProject={canManageProject}
              />
            )}

            {/* The standup view (Phase 15 §5) — placed in the toolbar rather than
              the sidebar, because this is exactly where a team is looking when
              a daily standup starts. `project:read`, same floor as the board
              itself, so no extra gate is needed here beyond `projectId` being
              known. */}
            {projectId !== null && (
              <Link
                to="/projects/$projectId/standup"
                params={{ projectId }}
                className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              >
                Standup
              </Link>
            )}

            {/* Grouping and sorting are view SETTINGS (§5.6) — meaningless for
              the table, which has its own columns, and for the calendar,
              which is inherently grouped by date — so they only render for
              board and list. */}
            {view !== 'table' && view !== 'calendar' && (
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
              {sprintCards.length} {sprintCards.length === 1 ? 'card' : 'cards'}
              {filter !== null && ' matching'}
              {sprint !== null && ` in ${sprint === 'backlog' ? 'backlog' : 'sprint'}`}
            </span>

            {othersPresent.length > 0 && (
              <div
                className="flex items-center -space-x-1.5"
                title={othersPresent.map((person) => person.label).join(', ')}
              >
                {othersPresent.slice(0, 5).map((person) => (
                  <span
                    key={person.userId}
                    className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-accent text-[10px] font-medium text-accent-ink"
                  >
                    {person.label.slice(0, 2).toUpperCase()}
                  </span>
                ))}
                {othersPresent.length > 5 && (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken text-[10px] font-medium text-ink-muted">
                    +{othersPresent.length - 5}
                  </span>
                )}
              </div>
            )}

            <ArchivedCardsDialog orgId={orgId} boardId={boardId} canManageBoard={canManageBoard} />
            <ShareBoardDialog orgId={orgId} boardId={boardId} />
            {/* Import/export is project-scoped — a board reached by a pasted
              URL with no `?project=` cannot know which project's cards it
              would move, so it waits for the vocabulary to resolve, exactly
              like the sprint picker above. */}
            {projectId !== null && (
              <ImportExportDialog
                orgId={orgId}
                boardId={boardId}
                projectId={projectId}
                canManageProject={canManageProject}
              />
            )}
          </div>
        </div>

        {view === 'board' && (
          <BoardView
            orgId={orgId}
            boardId={boardId}
            lists={liveLists}
            cards={sprintCards}
            statuses={statuses.data ?? []}
            people={people}
            groupBy={groupBy}
            sortBy={sortBy}
            selected={visibleSelection.selected}
            onToggleSelect={(cardId, extend) => {
              setSelection((previous) =>
                extend ? selectRange(previous, cardId, visibleIds) : toggle(previous, cardId),
              );
            }}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
            canManageBoard={canManageBoard}
          />
        )}

        {view === 'list' && (
          <ListView
            lists={liveLists}
            cards={sprintCards}
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
            cards={sprintCards}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
          />
        )}

        {view === 'calendar' && (
          <CalendarView
            cards={sprintCards}
            onOpenCard={(cardId) => {
              setSearch({ card: cardId as CardId });
            }}
          />
        )}

        {view === 'insights' && <BoardInsightsPanel orgId={orgId} boardId={boardId} />}

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

const VIEW_TOGGLE_OPTIONS = [
  { value: 'board', label: 'Board' },
  { value: 'list', label: 'List' },
  { value: 'table', label: 'Table' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'insights', label: 'Insights' },
] as const satisfies readonly {
  value: 'board' | 'table' | 'list' | 'calendar' | 'insights';
  label: string;
}[];

function ViewToggle({
  value,
  onChange,
}: {
  readonly value: 'board' | 'table' | 'list' | 'calendar' | 'insights';
  readonly onChange: (value: 'board' | 'table' | 'list' | 'calendar' | 'insights') => void;
}) {
  return (
    <Segmented value={value} onChange={onChange} options={VIEW_TOGGLE_OPTIONS} aria-label="View" />
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
