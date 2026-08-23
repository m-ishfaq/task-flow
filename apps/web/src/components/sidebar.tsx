import { useState, type ComponentType } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  ListChecks,
  MessageSquare,
  Pin,
  Phone,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Star,
  Users,
  Workflow,
  type LucideProps,
} from 'lucide-react';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { useSession } from '../lib/session.js';
import { pinKey, pinnedProjectIds, useUi } from '../lib/ui-store.js';
import { useIsDesktop } from '../lib/use-media-query.js';
import { cn } from '../lib/cn.js';
import {
  activeSprintsQuery,
  boardsQuery,
  projectsQuery,
  type BoardSummary,
} from '../features/work/api.js';
import { api } from '../lib/trpc.js';
import { keys } from '../lib/query.js';
import { useBranding } from '../lib/branding-context.js';
import { FocusOnMountInput, Skeleton } from './primitives.js';

/**
 * The navigation tree (Phase 3.5 Wave 1, ai/phase-3.5-work-ux.md §4.1).
 *
 * ## What it replaced, and why that was the biggest gap
 *
 * A flat top nav — Projects / Settings / Permissions — plus a projects page. That
 * arrangement has no spatial model: nothing on screen shows the SHAPE of the
 * workspace, so reaching a board is a round trip through a list every time and
 * there is no answer to "where am I". The tree is the whole point; it is not
 * decoration for the same reason a file explorer is not decoration.
 *
 * Org → Project → Board, two levels deep. Deliberately not three: ClickUp's
 * Space → Folder → List adds a grouping level that earns its keep at dozens of
 * containers and costs a migration plus a permission question below that — see
 * the decision recorded in §10 of the spec.
 *
 * ## Boards are fetched per project, only when expanded
 *
 * One `boards.list` per open project, which `httpBatchLink` coalesces into a
 * single request. The alternative — one endpoint returning the whole tree —
 * would be fewer bytes and a new route whose authorization is a superset of two
 * existing ones, which is the kind of convenience that ends up leaking a board
 * name to someone who cannot open it.
 *
 * ## It never re-derives authorization
 *
 * A project the caller cannot read does not come back from `projects.list`, so
 * it is absent rather than hidden — §8.2's rule that the UI must not
 * reimplement `can()`. Nothing here inspects a role.
 */

/**
 * The top-level nav, as data.
 *
 * Nine near-identical `<Link>` blocks became one list, which is what makes the
 * ORDER and the GROUPING reviewable — previously both were implicit in the JSX,
 * and `Automations` landed in the middle of the daily surfaces simply because
 * that was where the file was convenient to edit.
 *
 * The grouping is by how often a person opens the thing, not by which phase
 * built it:
 *
 *   1. Where you start — your own work, and finding anything.
 *   2. The products you live in day to day.
 *
 * Configuration is NOT in this list; it lives in `CONFIG_ITEMS` below, pinned
 * to the bottom of the rail. See that constant for why the split exists.
 *
 * Every item is shown to everyone. A member who lacks a permission gets an
 * honest refusal from the page, never a menu that quietly differs by role —
 * §8.2, because the hidden version is the one that never gets tested.
 */
/** A `lucide-react` icon component — every nav row's leading glyph. */
type NavIcon = ComponentType<LucideProps>;

const PRIMARY_SECTIONS: readonly {
  readonly id: string;
  readonly items: readonly {
    readonly to: string;
    readonly label: string;
    readonly icon: NavIcon;
  }[];
}[] = [
  {
    id: 'start',
    items: [
      { to: '/home', label: 'My tasks', icon: ListChecks },
      { to: '/search', label: 'Search', icon: Search },
    ],
  },
  {
    id: 'products',
    items: [
      { to: '/chat', label: 'Chat', icon: MessageSquare },
      { to: '/docs', label: 'Docs', icon: FileText },
      { to: '/calls', label: 'Calls', icon: Phone },
      { to: '/people', label: 'People', icon: Users },
    ],
  },
];

/**
 * Configuration, pinned below the tree rather than listed above it.
 *
 * These used to be the last flat group before the project tree, separated from
 * it by the same 1px rule that separated every other group — so `Automations`
 * read as the heading of the project list rather than as a peer of Chat and
 * Docs. Two unrelated things were adjacent and nothing said they were
 * unrelated.
 *
 * Moving them into a pinned footer fixes both halves at once. They are no
 * longer touching the tree, and — because the footer does not scroll — they
 * stay in one place at any workspace size. That is the property the tree
 * itself cannot have: it GROWS, so anything positioned after it in a single
 * scrolling column moves as projects are added and stops being findable by
 * muscle memory. Slack's and Linear's rails are shaped this way for the same
 * reason.
 */
const CONFIG_ITEMS: readonly {
  readonly to: string;
  readonly label: string;
  readonly icon: NavIcon;
}[] = [{ to: '/automations', label: 'Automations', icon: Workflow }];

/**
 * The active-state contract, defined once for every navigable thing in the rail.
 *
 * ## The active state has to differ from HOVER, not just from resting
 *
 * The first version used `bg-surface-hover` for both, so "you are here" and
 * "your mouse is here" rendered identically — which means neither reads as
 * anything. The accent bar is the persistent signal: it survives the pointer
 * moving away, and it is the only thing on the item that hover never applies.
 *
 * ## Why a pseudo-element rather than a left border
 *
 * The border version had to be present-but-transparent when inactive so
 * becoming active did not shift the label two pixels sideways — which works,
 * and then has to be repeated on every item that wants the bar, including ones
 * whose `<Link>` does NOT start at the row's left edge. A project link sits
 * after a disclosure triangle, so its own left border would draw the bar in the
 * middle of the row.
 *
 * `before:` is absolutely positioned against the nearest positioned ancestor —
 * the ROW — so the bar lands at the row's left edge no matter how deep in the
 * row the link itself begins, and it reserves no layout space to begin with.
 * Every row that uses it is marked `relative`.
 *
 * The gradient (`from-accent to-accent/0`, top to bottom) is the redesign's
 * signature active-indicator — the same "flow" idea as the priority color
 * bar on a card tile (`styles.css`'s `--color-priority-urgent` comment):
 * one considered visual motif reused in the two places a viewer's eye
 * actually needs to land on "where am I / what matters here", not a
 * decorative flourish added somewhere unrelated.
 */
const ACTIVE_BAR =
  'before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-gradient-to-b before:from-accent before:to-accent/0';

/**
 * The tint, applied to the ROW rather than to the link.
 *
 * `activeProps` can only style the `<Link>`, and a link that starts after a
 * disclosure triangle would tint only the part of the row to the right of it —
 * a highlight with a notch cut out of its left edge. TanStack Router stamps
 * `data-status="active"` on the rendered anchor, so the row can ask whether it
 * CONTAINS the active link and tint itself edge to edge.
 */
const ACTIVE_ROW = 'has-[a[data-status=active]]:bg-accent/10';

/** One top-level nav item — icon-leading, per the Slack/Teams rail reference. */
function NavLink({
  to,
  label,
  icon: Icon,
}: {
  readonly to: string;
  readonly label: string;
  readonly icon: NavIcon;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'relative mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink-muted',
        'transition-colors duration-[var(--motion-fast)]',
        'hover:bg-surface-hover hover:text-ink',
      )}
      activeProps={{
        className: cn('bg-accent/10 text-accent hover:bg-accent/10 hover:text-accent', ACTIVE_BAR),
      }}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function Sidebar() {
  const orgId = useSession((state) => state.orgId);
  const { productName, logoUrl } = useBranding();
  const collapsed = useUi((state) => !state.sidebarOpen);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const isDesktop = useIsDesktop();

  /* `sidebarOpen` is a DESKTOP preference — collapse to a rail to reclaim
     width. Below `md` this component is rendered inside Shell's off-canvas
     drawer, which is either fully on screen or fully off it; there is no
     "rail" state for a drawer, and respecting a collapsed desktop preference
     here would mean opening the mobile drawer sometimes shows a 3rem sliver
     with none of the tree that's the entire reason to open it. So `open`
     below is desktop-collapse-aware only when `isDesktop` is true, and always
     "fully expanded" otherwise — the drawer's own open/closed state is
     handled by Shell's `translate-x` and `inert`, not by this component. */
  const open = isDesktop ? !collapsed : true;

  const projects = useQuery({ ...projectsQuery(orgId ?? ''), enabled: orgId !== null });

  const live = (projects.data ?? []).filter((project) => project.archivedAt === null);

  return (
    <aside
      aria-label="Workspace"
      className={cn(
        /* `min-h-0 flex-1`, not a percentage. This was `h-[94%]` — a magic
           number chosen to leave room for Shell's `SidebarFooter`, which is a
           sibling in the same flex column and already sizes itself. The
           percentage was both wrong (6% of the viewport is not the footer's
           height at every window size, so the rail either overlapped it or
           left a gap) and load-bearing in the wrong way: it is what stopped
           an inner scroll region from ever resolving a height, because a
           `flex-1` child inside a percentage-height parent still needs
           `min-h-0` above it to be allowed to shrink. */
        'flex min-h-0 flex-1 flex-col border-r border-line bg-surface-raised transition-[width]',
        open ? 'w-72 md:w-60' : 'w-12',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line/50 px-4">
        {open && (
          <Link
            to="/projects"
            className="flex min-w-0 items-center gap-2.5 truncate px-1 text-[14px] font-semibold text-ink transition-colors hover:text-accent"
          >
            {logoUrl !== null && (
              <img src={logoUrl} alt="" className="size-5 shrink-0 rounded object-contain" />
            )}
            {/* `font-display` (Geist Sans) — the wordmark is the other headline
                use of the display face alongside the login page's heading. */}
            <span className="font-display truncate tracking-tight">{productName}</span>
          </Link>
        )}
        {/* The collapse toggle only makes sense as a desktop rail control —
            below `md` the drawer's own backdrop and header hamburger are the
            close affordances, and a second, differently-behaved toggle here
            would be confusing next to them. */}
        {isDesktop && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={open}
            className="ml-auto rounded p-1.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
          >
            {open ? (
              <PanelLeftClose aria-hidden="true" className="size-4" strokeWidth={2} />
            ) : (
              <PanelLeftOpen aria-hidden="true" className="size-4" strokeWidth={2} />
            )}
          </button>
        )}
      </div>

      {/* Collapsed is a rail, not a narrow tree. Truncating project names to two
          characters would produce a column of ambiguous stubs; hiding them and
          keeping the toggle is honest about what a 3rem column can show. */}
      {open && (
        <>
          {/* Fixed. These four-to-six destinations are the ones reached by
              muscle memory, and they must be in the same place whether the
              workspace has two projects or eighty. */}
          <nav aria-label="Main" className="shrink-0 px-2 pt-2">
            {PRIMARY_SECTIONS.map((section, index) => (
              <div key={section.id} className={cn(index > 0 && 'mt-2 border-t border-line pt-2')}>
                {section.items.map((item) => (
                  <NavLink key={item.to} to={item.to} label={item.label} icon={item.icon} />
                ))}
              </div>
            ))}
          </nav>

          {/* The ONLY scrolling region in the rail. Everything that grows with
              the workspace lives here, and everything that must not move lives
              outside it. */}
          <nav
            aria-label="Projects"
            className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-line px-2 pt-2 pb-2"
          >
            <PinnedBoards />

            {/* A heading that is also the link to `/projects`. It used to be a
                bare `<p>`, which meant the projects page — the only place a
                project is created or archived — had no representation in the
                rail at all and no active state when you were standing on it.
                Styled as a heading and behaving as a nav item, because it is
                genuinely both. */}
            <Link
              to="/projects"
              className={cn(
                'relative mb-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide uppercase',
                'text-ink-faint hover:bg-surface-hover hover:text-ink',
              )}
              activeProps={{
                className: cn(
                  'bg-accent/10 text-accent hover:bg-accent/10 hover:text-accent',
                  ACTIVE_BAR,
                ),
              }}
            >
              <Folder aria-hidden="true" className="size-3" strokeWidth={2.25} />
              Projects
            </Link>

            {projects.isPending ? (
              <div aria-busy="true" className="space-y-1.5 px-1 py-1">
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-5 w-3/5" />
                <Skeleton className="h-5 w-2/3" />
              </div>
            ) : live.length === 0 ? (
              <Link to="/projects" className="block px-2 py-1 text-xs text-accent underline">
                Create your first project
              </Link>
            ) : (
              <ul>
                {live.map((project) => (
                  <ProjectNode
                    key={project.projectId}
                    orgId={orgId ?? ''}
                    projectId={project.projectId as ProjectId}
                    name={project.name}
                    projectKey={project.key}
                    canCreateBoard={project.capabilities.update}
                  />
                ))}
              </ul>
            )}
          </nav>

          {/* Fixed, below the tree — see CONFIG_ITEMS for why it is down here
              rather than in the list above. */}
          <nav
            aria-label="Configuration"
            className="shrink-0 border-t border-line px-2 pt-2 pb-1.5"
          >
            {CONFIG_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} label={item.label} icon={item.icon} />
            ))}
          </nav>
        </>
      )}
    </aside>
  );
}

function ProjectNode({
  orgId,
  projectId,
  name,
  projectKey,
  canCreateBoard,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly projectKey: string;
  /** project:update on THIS project — createBoard enforces it on the parent, not board:create. */
  readonly canCreateBoard: boolean;
}) {
  const collapsed = useUi((state) => state.collapsedProjects.includes(projectId));
  const toggleProject = useUi((state) => state.toggleProject);

  /* Boards load only for an open project, and stay cached once loaded so
     re-expanding is instant. */
  const boards = useQuery({ ...boardsQuery(orgId, projectId), enabled: !collapsed });

  const live = (boards.data ?? []).filter((board) => board.archivedAt === null);

  return (
    <li>
      {/* `relative` so the active bar has something to pin to, and ACTIVE_ROW
          so the tint covers the disclosure triangle too — see those constants
          for why the styling is split across the row and the link. */}
      <div className={cn('group relative flex items-center rounded-md', ACTIVE_ROW)}>
        <button
          type="button"
          onClick={() => {
            toggleProject(projectId);
          }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
          className="flex w-5 shrink-0 items-center justify-center py-1 text-ink-faint hover:text-ink"
        >
          {collapsed ? (
            <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
          )}
        </button>

        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="min-w-0 flex-1 truncate rounded py-1 pr-1 text-xs text-ink-muted hover:text-ink"
          activeProps={{ className: cn('font-medium text-accent', ACTIVE_BAR) }}
          title={`${name} (${projectKey}) — open project settings`}
        >
          {name}
        </Link>
      </div>

      {/* The running sprint, OUTSIDE the collapse (10.6 D3).
          Deliberately not inside the expanded section with the boards: the
          whole point is that a running sprint is visible without clicking
          anything, and a line that hides when the project is collapsed would
          be the dropdown problem again one level up. Absent entirely when the
          project has no active sprint, so projects that do not run sprints
          gain no noise. */}
      <ActiveSprintLine orgId={orgId} projectId={projectId} />

      {!collapsed && (
        <ul className="mb-1 ml-5 border-l border-line pl-2">
          {boards.isPending ? (
            <li aria-busy="true" className="py-1">
              <Skeleton className="h-4 w-3/4" />
            </li>
          ) : (
            live.map((board) => (
              <BoardLink key={board.boardId} board={board} projectId={projectId} />
            ))
          )}

          {/* An expanded project with no boards used to read "No boards" and
              offer nothing — a dead end on the surface people actually
              navigate from, with the only `+ Board` button sitting on the
              /projects page. A project without a board has nowhere to put
              cards, so this is the one place the affordance is most needed. */}
          {!boards.isPending && canCreateBoard && (
            <AddBoard orgId={orgId} projectId={projectId} isFirst={live.length === 0} />
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * One project's active sprint, as a single ambient line (10.6 D3).
 *
 * Reads the org-wide `sprints.active` query rather than the per-project sprint
 * list: the sidebar renders every project at once, so a per-project read would
 * be one request per project and a tree that fills in raggedly. One query,
 * shared by every row, and each row picks its own out of it.
 *
 * Renders NOTHING while loading and nothing when there is no active sprint —
 * no skeleton. A placeholder here would make every project look like it has a
 * sprint for the first moment of every page load, which is worse than the line
 * appearing a beat late.
 */
function ActiveSprintLine({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const active = useQuery({ ...activeSprintsQuery(orgId), enabled: orgId !== '' });
  const sprint = (active.data ?? []).find((entry) => entry.projectId === projectId);
  if (sprint === undefined) return null;

  const remaining = daysRemaining(sprint.endsOn);

  return (
    <Link
      to="/projects/$projectId/sprints"
      params={{ projectId }}
      className="ml-5 flex items-center gap-1.5 rounded py-0.5 pr-1 pl-2 text-[11px] text-ink-faint hover:text-ink"
      activeProps={{ className: 'text-accent' }}
      title={`${sprint.name} — ends ${sprint.endsOn}`}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
      <span className="min-w-0 flex-1 truncate">{sprint.name}</span>
      <span className="shrink-0 tabular-nums">{remaining}</span>
    </Link>
  );
}

/**
 * "3d left", "today", or "overdue".
 *
 * Computed from the DATE string the server sends (`ends_on` is a `date`, not a
 * timestamp — a sprint is a span of days). Parsed as UTC midnight and compared
 * against local midnight so a person three hours ahead of the server does not
 * see a sprint expire early; the value is a rough count for a sidebar, and
 * pretending to more precision than a `date` column carries would be a lie.
 */
function daysRemaining(endsOn: string): string {
  const end = new Date(`${endsOn}T00:00:00Z`).getTime();
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((end - todayUtc) / 86_400_000);

  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return `${String(days)}d left`;
}

/**
 * Creating a board where the boards are.
 *
 * The API and the mutation already existed — `api.work.boards.create`, called
 * from the projects page — so this adds no capability. What it adds is REACH:
 * the board tree is where people go looking for boards, and the only button
 * that made one lived on a different page.
 *
 * Deliberately not a duplicate implementation of the projects page's form:
 * both call the same route, both invalidate the same key, and the difference
 * between them is only how much room they have.
 */
function AddBoard({
  orgId,
  projectId,
  isFirst,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly isFirst: boolean;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: (boardName: string) =>
      api.work.boards.create.mutate({ projectId, name: boardName }),
    onSuccess: async () => {
      setName('');
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: keys.boards(orgId, projectId) });
    },
  });

  if (!adding) {
    return (
      <li>
        <button
          type="button"
          onClick={() => {
            setAdding(true);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          <Plus aria-hidden="true" className="size-3" strokeWidth={2.25} />
          {isFirst ? 'Add the first board' : 'Board'}
        </button>
      </li>
    );
  }

  return (
    <li>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') create.mutate(name.trim());
        }}
      >
        {/* `FocusOnMountInput`, not `autoFocus`: the attribute is banned by
            jsx-a11y because it steals focus on page load. This input is
            mounted by a click, so focusing it follows the user rather than
            surprising them — the same reasoning the projects page states. */}
        <FocusOnMountInput
          aria-label="New board name"
          placeholder="Board name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setName('');
              setAdding(false);
            }
          }}
          className="h-6 w-full text-[11px]"
        />
        {create.isError && (
          <p role="alert" className="px-1 py-0.5 text-[10px] text-danger">
            Could not create that board.
          </p>
        )}
      </form>
    </li>
  );
}

function BoardLink({
  board,
  projectId,
}: {
  readonly board: BoardSummary;
  readonly projectId: ProjectId;
}) {
  const pinned = useUi((state) => state.pinnedBoards.includes(pinKey(projectId, board.boardId)));
  const togglePinnedBoard = useUi((state) => state.togglePinnedBoard);

  return (
    <li
      className={cn(
        'group relative flex items-center rounded-md hover:bg-surface-hover',
        ACTIVE_ROW,
      )}
    >
      <Link
        to="/boards/$boardId"
        params={{ boardId: board.boardId as BoardId }}
        /* `project` travels in the search params because the card detail panel
           needs it for labels and custom fields, which are project-scoped
           vocabulary. A board reached without it renders a panel missing both. */
        search={{ view: 'board', project: projectId }}
        /* `includeSearch: false` — WITHOUT it this link is active only while
           the URL's search params still match the ones above, so switching to
           the table view, opening a card, or applying a filter silently
           un-highlights the board you are looking at. The path is what
           identifies a board; `view` and `project` are state on top of it. */
        activeOptions={{ includeSearch: false }}
        className="min-w-0 flex-1 truncate rounded py-1 pl-1.5 text-xs text-ink-muted hover:text-ink"
        activeProps={{ className: cn('font-medium text-accent', ACTIVE_BAR) }}
      >
        {board.name}
      </Link>

      <button
        type="button"
        onClick={() => {
          togglePinnedBoard(projectId, board.boardId);
        }}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${board.name}` : `Pin ${board.name}`}
        /* Always in the DOM, revealed on hover or focus. Rendering it only on
           hover puts it out of reach of the keyboard entirely, which is the
           standard way this pattern excludes people. */
        className={cn(
          'shrink-0 px-1.5 py-1 focus-visible:opacity-100',
          pinned
            ? 'text-warning opacity-100'
            : 'text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink',
        )}
      >
        <Star
          aria-hidden="true"
          className="size-3"
          strokeWidth={2.25}
          fill={pinned ? 'currentColor' : 'none'}
        />
      </button>
    </li>
  );
}

/**
 * Pinned boards, resolved against the boards the caller can actually see.
 *
 * Only the projects that HOLD a pin are queried — that is what the project id in
 * the pin key buys, and it is the difference between one extra request and one
 * per project on every page load.
 *
 * A pin whose board no longer resolves is dropped from the render rather than
 * shown as an id. That covers an archived board, a revoked permission, and a pin
 * left behind by a previous user of this browser: three ordinary situations, none
 * worth a message, and the last of which is also why nothing here can leak a
 * name — `boards.list` only ever returns what the current caller may read.
 */
function PinnedBoards() {
  const pins = useUi((state) => state.pinnedBoards);
  const projectIds = pinnedProjectIds(pins);

  if (projectIds.length === 0) return null;

  return (
    <>
      <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
        <Pin aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Pinned
      </p>
      <ul>
        {projectIds.map((projectId) => (
          <PinnedFromProject key={projectId} projectId={projectId as ProjectId} pins={pins} />
        ))}
      </ul>
    </>
  );
}

function PinnedFromProject({
  projectId,
  pins,
}: {
  readonly projectId: ProjectId;
  readonly pins: readonly string[];
}) {
  const orgId = useSession((state) => state.orgId) ?? '';

  /* The same query key the expanded project node uses, so an already-open
     project costs nothing and the request happens only for a collapsed project
     that contains a pin. */
  const boards = useQuery(boardsQuery(orgId, projectId));

  const matches = (boards.data ?? []).filter(
    (board) => board.archivedAt === null && pins.includes(pinKey(projectId, board.boardId)),
  );

  return (
    <>
      {matches.map((board) => (
        <BoardLink key={board.boardId} board={board} projectId={projectId} />
      ))}
    </>
  );
}
