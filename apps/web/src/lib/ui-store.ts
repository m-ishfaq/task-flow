import { create } from 'zustand';

/**
 * Client-only state (PLAN.md §10.5).
 *
 * The rule this file exists to obey: Zustand holds ONLY things with no server
 * representation. Drag-in-flight, sidebar collapse, an unsaved filter draft, the
 * command palette. Nothing here is fetched, and nothing fetched belongs here.
 *
 * A card copied into this store would need its own invalidation, its own
 * optimistic rollback, and its own reconciliation with the query cache — three
 * mechanisms that already exist, reimplemented worse and silently diverging. If
 * something in this file starts needing a `refetch`, it is in the wrong place.
 *
 * Note what is also NOT here: which card is open. That is a URL search param
 * (`?card=`), because a card panel must be deep-linkable, shareable, and correct
 * under the back button (§10.5). State that belongs in the URL and lives in a
 * store instead is how "share this card" stops working.
 */

export type ViewMode = 'board' | 'table';

/**
 * Sidebar shape, remembered between visits.
 *
 * Persisted because a navigation tree that forgets what you collapsed is a tree
 * you re-collapse on every reload. Safe to leave in `localStorage` and safe
 * across users: both hold opaque uuids, and a pinned board belonging to someone
 * else's org simply does not appear in the current caller's board list, so it
 * renders as nothing rather than as a name they should not see. Neither key is a
 * credential and neither confers access — the server decides every read.
 */
const COLLAPSED_KEY = 'taskflow.sidebar.collapsed';
const PINNED_KEY = 'taskflow.sidebar.pinned';
const RECENT_KEY = 'taskflow.sidebar.recentBoards';

/** A board the user recently visited, stored for the sidebar's Recents section. */
export interface RecentBoard {
  readonly boardId: string;
  readonly projectId: string;
  readonly name: string;
  readonly projectKey: string | undefined;
}

function readRecent(): readonly RecentBoard[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentBoard =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentBoard).boardId === 'string' &&
        typeof (entry as RecentBoard).projectId === 'string' &&
        typeof (entry as RecentBoard).name === 'string',
    );
  } catch {
    return [];
  }
}

function writeRecent(boards: readonly RecentBoard[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(boards));
  } catch {
    // Private browsing and blocked storage both throw.
  }
}

const MAX_RECENT = 5;

function readIds(key: string): readonly string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    /* Validated, not cast. This is `localStorage`, which any script on the page
       can write and which survives a version of the app that stored something
       else here — and `.map()` over a non-array throws during render, taking the
       whole shell down over a stale preference. */
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeIds(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Private browsing and blocked storage both throw. A preference that does
    // not survive a reload is a worse experience, not a broken app.
  }
}

function toggled(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

/** How a pinned board is identified. See `pinnedBoards`. */
export function pinKey(projectId: string, boardId: string): string {
  return `${projectId}/${boardId}`;
}

/** The projects that have at least one pin, so only those are queried. */
export function pinnedProjectIds(pins: readonly string[]): readonly string[] {
  return [...new Set(pins.map((pin) => pin.split('/')[0] ?? ''))].filter((id) => id !== '');
}

interface UiState {
  readonly sidebarOpen: boolean;
  /**
   * The Docs page's Spaces tree (docs-page.tsx), collapsed the same way the
   * main sidebar is: a narrow rail holding the toggle and nothing else.
   * Session-scoped like `sidebarOpen` — remembering it between visits is the
   * same "tree that forgets what you collapsed" problem, but a per-reload
   * default of open is also what the main sidebar already accepts.
   */
  readonly docsSpacesOpen: boolean;
  readonly viewMode: ViewMode;
  /**
   * Projects whose board list is folded away.
   *
   * Stored as the COLLAPSED set rather than the expanded one, so a project
   * created later — or first seen on another machine — arrives expanded. The
   * inverse defaults every new project to hidden, which reads as the sidebar
   * failing to notice it.
   */
  readonly collapsedProjects: readonly string[];
  /**
   * Boards pinned to the top of the sidebar, as `projectId/boardId`.
   *
   * The project id is in the key because a board's NAME lives in
   * `boards.list`, which is queried per project. With bare board ids the pinned
   * section would have to fetch every project's boards to find out which one
   * each pin belonged to — turning a lazily-loaded tree into a full fan-out on
   * every page load, for the sake of two shortcuts. `pinKey` is the only place
   * that knows the shape.
   */
  readonly pinnedBoards: readonly string[];
  /**
   * Boards the user recently visited, most recent first.
   *
   * Stored in localStorage and shown at the top of the sidebar scroll region
   * as a quick-access shortcut. Max 5 entries — the 80% case is "I visit the
   * same 3-5 boards daily". The name is captured at visit time so collapsed
   * projects need no extra query; a renamed board shows a slightly stale name,
   * which is acceptable for a shortcut.
   */
  readonly recentBoards: readonly RecentBoard[];
  /**
   * The card being dragged, if any.
   *
   * Genuinely ephemeral: it exists between pointer-down and drop and has no
   * server equivalent at any moment. Kept here rather than in component state
   * so the drop target and the drag overlay — which are not in the same subtree
   * — can both see it.
   */
  readonly draggingCardId: string | null;
  /** The command palette (Cmd/Ctrl+K) — see `command-palette.tsx`. */
  readonly commandPaletteOpen: boolean;
  /** The `?` keyboard-shortcuts overlay, discoverable from the same key everywhere. */
  readonly shortcutsOpen: boolean;
  /**
   * The sidebar as an off-canvas drawer, below the `md` breakpoint
   * (ai/phase-6.5-ui-polish.md Wave 6).
   *
   * Deliberately a SEPARATE flag from `sidebarOpen` rather than the same one
   * reused at a different breakpoint. `sidebarOpen` means "rail or full width"
   * on a screen where the sidebar is always present and takes up permanent
   * layout space; below `md` there is no room for even a rail alongside
   * content, so the sidebar is either a full-width drawer covering the page or
   * entirely off-screen. Those are two different questions, and collapsing
   * them into one boolean would make toggling one break the other the next
   * time the viewport crosses the breakpoint.
   *
   * Not persisted, unlike `sidebarOpen`'s cousins in this file — a drawer that
   * remembered being open across a reload would cover the page on first paint
   * on a phone, which is a worse default than always starting closed.
   */
  readonly mobileNavOpen: boolean;
}

interface UiActions {
  readonly toggleSidebar: () => void;
  readonly toggleDocsSpaces: () => void;
  readonly setViewMode: (mode: ViewMode) => void;
  readonly setDraggingCard: (cardId: string | null) => void;
  readonly toggleProject: (projectId: string) => void;
  readonly togglePinnedBoard: (projectId: string, boardId: string) => void;
  readonly addRecentBoard: (board: RecentBoard) => void;
  readonly setCommandPaletteOpen: (open: boolean) => void;
  readonly setShortcutsOpen: (open: boolean) => void;
  readonly toggleMobileNav: () => void;
  readonly closeMobileNav: () => void;
}

export const useUi = create<UiState & UiActions>((set) => ({
  sidebarOpen: true,
  docsSpacesOpen: true,
  viewMode: 'board',
  draggingCardId: null,
  collapsedProjects: readIds(COLLAPSED_KEY),
  pinnedBoards: readIds(PINNED_KEY),
  recentBoards: readRecent(),
  commandPaletteOpen: false,
  shortcutsOpen: false,
  mobileNavOpen: false,

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },
  toggleDocsSpaces: () => {
    set((state) => ({ docsSpacesOpen: !state.docsSpacesOpen }));
  },
  setViewMode: (viewMode) => {
    set({ viewMode });
  },
  setDraggingCard: (draggingCardId) => {
    set({ draggingCardId });
  },

  toggleProject: (projectId) => {
    set((state) => {
      const collapsedProjects = toggled(state.collapsedProjects, projectId);
      writeIds(COLLAPSED_KEY, collapsedProjects);
      return { collapsedProjects };
    });
  },

  togglePinnedBoard: (projectId, boardId) => {
    set((state) => {
      const pinnedBoards = toggled(state.pinnedBoards, pinKey(projectId, boardId));
      writeIds(PINNED_KEY, pinnedBoards);
      return { pinnedBoards };
    });
  },

  addRecentBoard: (board) => {
    set((state) => {
      // Dedupe by boardId, move to front, cap at MAX_RECENT
      const filtered = state.recentBoards.filter((r) => r.boardId !== board.boardId);
      const recentBoards = [board, ...filtered].slice(0, MAX_RECENT);
      writeRecent(recentBoards);
      return { recentBoards };
    });
  },

  setCommandPaletteOpen: (commandPaletteOpen) => {
    set({ commandPaletteOpen });
  },
  setShortcutsOpen: (shortcutsOpen) => {
    set({ shortcutsOpen });
  },

  toggleMobileNav: () => {
    set((state) => ({ mobileNavOpen: !state.mobileNavOpen }));
  },
  closeMobileNav: () => {
    set({ mobileNavOpen: false });
  },
}));
