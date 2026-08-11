import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { useSession } from '../lib/session.js';
import { pinKey, pinnedProjectIds, useUi } from '../lib/ui-store.js';
import { useIsDesktop } from '../lib/use-media-query.js';
import { cn } from '../lib/cn.js';
import { boardsQuery, projectsQuery, type BoardSummary } from '../features/work/api.js';
import { api } from '../lib/trpc.js';
import { keys } from '../lib/query.js';
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
 *   3. Configuration you touch occasionally and then leave alone.
 *
 * Projects and pinned boards follow below, and stay at the bottom on purpose:
 * they are a TREE that grows, so anything under them would move as the
 * workspace grows and stop being findable by muscle memory. Same reason a chat
 * app puts channels last.
 *
 * Every item is shown to everyone. A member who lacks a permission gets an
 * honest refusal from the page, never a menu that quietly differs by role —
 * §8.2, because the hidden version is the one that never gets tested.
 */
const NAV_SECTIONS: readonly {
  readonly id: string;
  readonly items: readonly { readonly to: string; readonly label: string }[];
}[] = [
  {
    id: 'start',
    items: [
      { to: '/home', label: 'My tasks' },
      { to: '/search', label: 'Search' },
    ],
  },
  {
    id: 'products',
    items: [
      { to: '/chat', label: 'Chat' },
      { to: '/docs', label: 'Docs' },
      { to: '/calls', label: 'Calls' },
      { to: '/people', label: 'People' },
    ],
  },
  {
    id: 'configuration',
    items: [{ to: '/automations', label: 'Automations' }],
  },
];

/**
 * One top-level nav item.
 *
 * ## The active state has to differ from HOVER, not just from resting
 *
 * The first version used `bg-surface-hover` for both, so "you are here" and
 * "your mouse is here" rendered identically — which means neither reads as
 * anything. The accent bar is the persistent signal: it survives the pointer
 * moving away, and it is the only thing on the item that hover never applies.
 *
 * The border is present-but-transparent when inactive rather than absent, so
 * becoming active does not shift the label by two pixels.
 */
function NavLink({ to, label }: { readonly to: string; readonly label: string }) {
  return (
    <Link
      to={to}
      className="mb-0.5 block rounded border-l-2 border-transparent px-1.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
      activeProps={{ className: 'border-accent bg-accent/10 text-accent hover:text-accent' }}
    >
      {label}
    </Link>
  );
}

export function Sidebar() {
  const orgId = useSession((state) => state.orgId);
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
        'flex shrink-0 flex-col border-r border-line h-[94%] bg-surface-raised transition-[width]',
        open ? 'w-72 md:w-60' : 'w-12',
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        {open && (
          <Link to="/projects" className="truncate px-1 text-sm font-semibold text-ink">
            TaskFlow
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
            className="ml-auto rounded px-1.5 py-1 text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
          >
            {open ? '«' : '»'}
          </button>
        )}
      </div>

      {/* Collapsed is a rail, not a narrow tree. Truncating project names to two
          characters would produce a column of ambiguous stubs; hiding them and
          keeping the toggle is honest about what a 3rem column can show. */}
      {open && (
        <nav aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {NAV_SECTIONS.map((section, index) => (
            <div
              key={section.id}
              className={cn(
                index > 0 && 'mt-2 border-t border-line pt-2',
                index === NAV_SECTIONS.length - 1 && 'mb-1',
              )}
            >
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} label={item.label} />
              ))}
            </div>
          ))}

          <PinnedBoards />

          <p className="px-1 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
            Projects
          </p>

          {projects.isPending ? (
            <div aria-busy="true" className="space-y-1.5 px-1 py-1">
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-3/5" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : live.length === 0 ? (
            <Link to="/projects" className="block px-1 py-1 text-xs text-accent underline">
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
                />
              ))}
            </ul>
          )}
        </nav>
      )}
    </aside>
  );
}

function ProjectNode({
  orgId,
  projectId,
  name,
  projectKey,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly projectKey: string;
}) {
  const collapsed = useUi((state) => state.collapsedProjects.includes(projectId));
  const toggleProject = useUi((state) => state.toggleProject);

  /* Boards load only for an open project, and stay cached once loaded so
     re-expanding is instant. */
  const boards = useQuery({ ...boardsQuery(orgId, projectId), enabled: !collapsed });

  const live = (boards.data ?? []).filter((board) => board.archivedAt === null);

  return (
    <li>
      <div className="group flex items-center rounded hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => {
            toggleProject(projectId);
          }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
          className="w-5 shrink-0 py-1 text-[10px] text-ink-faint hover:text-ink"
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="min-w-0 flex-1 truncate py-1 text-xs text-ink-muted hover:text-ink"
          activeProps={{ className: 'font-medium text-accent' }}
          title={`${name} (${projectKey}) — open project settings`}
        >
          {name}
        </Link>
      </div>

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
          {!boards.isPending && (
            <AddBoard orgId={orgId} projectId={projectId} isFirst={live.length === 0} />
          )}
        </ul>
      )}
    </li>
  );
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
          className="w-full rounded px-1 py-1 text-left text-[11px] text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          {isFirst ? '+ Add the first board' : '+ Board'}
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
    <li className="group flex items-center rounded hover:bg-surface-hover">
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
        className="min-w-0 flex-1 truncate border-l-2 border-transparent py-1 pl-1.5 text-xs text-ink-muted hover:text-ink"
        activeProps={{ className: 'border-accent font-medium text-accent' }}
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
          'shrink-0 px-1.5 py-1 text-[10px] focus-visible:opacity-100',
          pinned
            ? 'text-warning opacity-100'
            : 'text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink',
        )}
      >
        ★
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
      <p className="px-1 pb-1 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
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
