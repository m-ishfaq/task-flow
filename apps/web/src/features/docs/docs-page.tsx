import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId, PageId, SpaceId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useUi } from '../../lib/ui-store.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import {
  Badge,
  Button,
  Empty,
  Field,
  FocusOnMountInput,
  Skeleton,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { DocsEditor } from './editor/docs-editor.js';
import {
  archivePage,
  archiveSpace,
  createPage,
  createSpace,
  invalidatePages,
  invalidateSpaces,
  pagesQuery,
  renamePage,
  spacesQuery,
  type PageSummary,
  type SpaceSummary,
} from './api.js';

/**
 * Spaces and pages (ai/phase-6-docs.md §5, Wave 1 of the UI — tree and
 * metadata only).
 *
 * Same two-pane shape as `chat-page.tsx`: a tree panel on the left, an open
 * page's metadata on the right, with `page` living in the URL for the
 * identical reason `chat`'s `channel` does — deep-linkable, back-button
 * correct, and the tree stays mounted across switches.
 *
 * Nothing here re-derives authorization (CLAUDE.md §8.2, mirrored from
 * `projects-page.tsx`): `spaces.list`/`pages.list` already omit anything the
 * caller cannot read, every button is shown unconditionally, and a caller
 * who cannot act gets the server's own FORBIDDEN rather than a hidden
 * control.
 *
 * The live editor (`DocsEditor`) goes through `apps/collab`'s Hocuspocus
 * gateway, a different protocol entirely from the tRPC calls this file
 * makes — an `Y.Doc` over a WebSocket, wired in `editor/docs-editor.tsx`.
 * It mounts per page via the `key={search.page}` remount below, so the
 * editor's own connection lifecycle (open/close the Yjs doc) is handled
 * correctly for free when switching pages. Reordering pages by drag is
 * likewise deferred — `pages.move` exists and is fully tested on the
 * backend, but nothing here calls it yet; Rename/Archive/Restore are the
 * Wave 1 surface.
 */

export function DocsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const search = useSearch({ from: '/docs' });

  const selectPage = (spaceId: SpaceId, pageId: PageId | undefined) => {
    void navigate({ to: '/docs', search: { space: spaceId, page: pageId } });
  };

  return (
    <div className="flex h-full min-h-0">
      <SpaceTreePanel
        orgId={orgId}
        selectedSpace={search.space}
        selectedPage={search.page}
        onSelectPage={selectPage}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {search.space === undefined || search.page === undefined ? (
          <Empty
            title="No page open"
            description="Pick a page on the left, or create one to get started."
          />
        ) : (
          <PagePanel key={search.page} orgId={orgId} spaceId={search.space} pageId={search.page} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Tree
 * -------------------------------------------------------------------------- */

function SpaceTreePanel({
  orgId,
  selectedSpace,
  selectedPage,
  onSelectPage,
}: {
  readonly orgId: string;
  readonly selectedSpace: SpaceId | undefined;
  readonly selectedPage: PageId | undefined;
  readonly onSelectPage: (spaceId: SpaceId, pageId: PageId | undefined) => void;
}) {
  const spaces = useQuery({ ...spacesQuery(orgId), enabled: orgId !== '' });
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  /* Minimizable exactly like the main sidebar: a `w-64` tree that collapses
     to a `w-12` rail holding just the toggle. State lives in ui-store (the
     same place `sidebarOpen` does) so the collapse survives navigation
     within the session. */
  const spacesOpen = useUi((state) => state.docsSpacesOpen);
  const toggleSpaces = useUi((state) => state.toggleDocsSpaces);

  const list = spaces.data ?? [];
  const live = list.filter((space) => space.archivedAt === null);
  const archived = list.filter((space) => space.archivedAt !== null);
  const shown = showArchived ? list : live;

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-line bg-surface-raised transition-[width]',
        spacesOpen ? 'w-64' : 'w-12',
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        {spacesOpen && <h2 className="truncate px-1 text-sm font-semibold text-ink">Spaces</h2>}
        <div className={cn('flex items-center gap-1', spacesOpen ? 'ml-auto' : 'mx-auto')}>
          {spacesOpen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreatingSpace((open) => !open);
              }}
            >
              {creatingSpace ? 'Cancel' : '+ Space'}
            </Button>
          )}
          <button
            type="button"
            onClick={toggleSpaces}
            aria-label={spacesOpen ? 'Collapse spaces panel' : 'Expand spaces panel'}
            aria-expanded={spacesOpen}
            className="rounded px-1.5 py-1 text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
          >
            {spacesOpen ? '«' : '»'}
          </button>
        </div>
      </div>

      {spacesOpen && creatingSpace && (
        <div className="border-b border-line p-2">
          <CreateSpaceForm
            orgId={orgId}
            onDone={() => {
              setCreatingSpace(false);
            }}
          />
        </div>
      )}

      {spacesOpen && (
        <nav aria-label="Spaces" className="min-h-0 flex-1 overflow-y-auto p-2">
          {spaces.isPending ? (
            <div aria-busy="true" className="space-y-1.5 p-1">
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          ) : spaces.isError ? (
            <ErrorView error={spaces.error} title="Could not load spaces" />
          ) : live.length === 0 && !showArchived ? (
            <p className="p-1 text-xs text-ink-faint">No spaces yet.</p>
          ) : (
            <ul className="space-y-1">
              {shown.map((space) => (
                <SpaceNode
                  key={space.spaceId}
                  orgId={orgId}
                  space={space}
                  selectedSpace={selectedSpace}
                  selectedPage={selectedPage}
                  onSelectPage={onSelectPage}
                />
              ))}
            </ul>
          )}

          {(archived.length > 0 || showArchived) && (
            <button
              type="button"
              onClick={() => {
                setShowArchived((value) => !value);
              }}
              className="mt-2 block px-1 text-[11px] text-ink-faint underline hover:text-ink-muted"
            >
              {showArchived ? 'Hide archived spaces' : `Show archived (${String(archived.length)})`}
            </button>
          )}
        </nav>
      )}
    </aside>
  );
}

function CreateSpaceForm({
  orgId,
  onDone,
}: {
  readonly orgId: string;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => createSpace({ name }),
    onSuccess: () => {
      invalidateSpaces(queryClient, orgId);
      onDone();
    },
    onError: (error) => {
      toast.failure('The space was not created', error);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0) return;
        create.mutate();
      }}
      className="flex gap-2"
    >
      <FocusOnMountInput
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        placeholder="Space name"
        className="flex-1"
      />
      <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
        Create
      </Button>
    </form>
  );
}

function SpaceNode({
  orgId,
  space,
  selectedSpace,
  selectedPage,
  onSelectPage,
}: {
  readonly orgId: string;
  readonly space: SpaceSummary;
  readonly selectedSpace: SpaceId | undefined;
  readonly selectedPage: PageId | undefined;
  readonly onSelectPage: (spaceId: SpaceId, pageId: PageId | undefined) => void;
}) {
  const [collapsed, setCollapsed] = useState(space.spaceId !== selectedSpace);
  const spaceId = space.spaceId as SpaceId;
  const pages = useQuery({ ...pagesQuery(orgId, spaceId), enabled: !collapsed });
  const [addingRootPage, setAddingRootPage] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const isArchived = space.archivedAt !== null;
  const live = (pages.data ?? []).filter((page) => page.archivedAt === null);
  const byParent = groupByParent(live);

  const restore = useMutation({
    mutationFn: () => archiveSpace({ spaceId, restore: true }),
    onSuccess: () => {
      invalidateSpaces(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('The space was not restored', error);
    },
  });

  return (
    <li>
      <div className="group flex items-center rounded hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => {
            setCollapsed((value) => !value);
          }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${space.name}` : `Collapse ${space.name}`}
          className="w-5 shrink-0 py-1 text-[10px] text-ink-faint hover:text-ink"
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <button
          type="button"
          onClick={() => {
            setCollapsed((value) => !value);
          }}
          className={cn(
            'min-w-0 flex-1 truncate py-1 text-left text-xs font-medium',
            isArchived ? 'text-ink-faint' : 'text-ink-muted hover:text-ink',
          )}
          title={space.name}
        >
          {space.name}
        </button>

        {isArchived && <Badge className="mr-1 text-warning">archived</Badge>}

        {isArchived ? (
          <button
            type="button"
            onClick={() => {
              restore.mutate();
            }}
            className="shrink-0 px-1.5 py-1 text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              // Also expand — a form appended to a collapsed tree body would
              // change state with nothing on screen to show for it.
              setCollapsed(false);
              setAddingRootPage((value) => !value);
            }}
            aria-label={`New page in ${space.name}`}
            className="shrink-0 px-1.5 py-1 text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
          >
            + Page
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mb-1 ml-5 border-l border-line pl-2">
          {addingRootPage && (
            <div className="py-1">
              <CreatePageForm
                orgId={orgId}
                spaceId={spaceId}
                parentPageId={null}
                onDone={() => {
                  setAddingRootPage(false);
                }}
              />
            </div>
          )}

          {pages.isPending ? (
            <div aria-busy="true" className="py-1">
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : pages.isError ? (
            <ErrorView error={pages.error} title="Could not load pages" />
          ) : live.length === 0 && !addingRootPage ? (
            <p className="py-1 text-[11px] text-ink-faint">No pages</p>
          ) : (
            <ul>
              {(byParent.get(null) ?? []).map((page) => (
                <PageNode
                  key={page.pageId}
                  orgId={orgId}
                  spaceId={spaceId}
                  page={page}
                  byParent={byParent}
                  selectedPage={selectedPage}
                  onSelect={(pageId) => {
                    onSelectPage(spaceId, pageId);
                  }}
                  depth={0}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/* The tree's indent is the SUM of every ancestor ul's margin + padding —
   nesting accumulates, so the first draft of this cap (one 24px step per
   level, capped at 6) still grew without bound: 24 + 48 + 72 + ... left a
   leaf six levels down ~500px right of the tree root in a 256px panel,
   off-screen at real width and a staircase when widened. The fix is an
   all-or-nothing contribution per level: levels 1..6 add one 16px step
   each (12px margin + 4px padding), and every deeper level adds ZERO, so
   the total is exactly `cap × 16px` no matter how deep the tree goes.
   Deeper pages render at the same capped indent; the connector line keeps
   marking where they sit. */
const TREE_INDENT_MARGIN = 12;
const TREE_INDENT_PADDING = 4;
const MAX_TREE_INDENT_DEPTH = 6;

function PageNode({
  orgId,
  spaceId,
  page,
  byParent,
  selectedPage,
  onSelect,
  depth,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly page: PageSummary;
  readonly byParent: ReadonlyMap<string | null, readonly PageSummary[]>;
  readonly selectedPage: PageId | undefined;
  readonly onSelect: (pageId: PageId) => void;
  /** How far from a space root this page sits. Root pages are 0. */
  readonly depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const pageId = page.pageId as PageId;
  const children = byParent.get(page.pageId) ?? [];
  const selected = pageId === selectedPage;

  /* `depth + 1` because this ul holds THIS page's children — their level is
     one past the page's own. All-or-nothing: levels within the cap add a
     16px step, deeper levels add zero, so the TOTAL stays bounded. */
  const withinIndentDepth = depth + 1 <= MAX_TREE_INDENT_DEPTH;

  return (
    <li>
      <div
        className={cn(
          'group flex items-center rounded',
          selected ? 'bg-surface-hover' : 'hover:bg-surface-hover',
        )}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setCollapsed((value) => !value);
            }}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${page.title}` : `Collapse ${page.title}`}
            className="w-4 shrink-0 py-1 text-[10px] text-ink-faint hover:text-ink"
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => {
            onSelect(pageId);
          }}
          className={cn(
            'min-w-0 flex-1 truncate py-1 text-left text-xs',
            selected ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink',
          )}
          title={page.title}
        >
          {page.title}
        </button>

        <button
          type="button"
          onClick={() => {
            setAddingChild((value) => !value);
          }}
          aria-label={`New page under ${page.title}`}
          className="shrink-0 px-1.5 py-1 text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
        >
          +
        </button>
      </div>

      {(addingChild || (!collapsed && children.length > 0)) && (
        <ul
          className="border-l border-line"
          style={{
            /* BOTH the margin and the padding are the indent, and both must
               stop past the cap — a level that kept padding would quietly
               keep accumulating and bring the truncation back. */
            marginLeft: withinIndentDepth ? `${String(TREE_INDENT_MARGIN)}px` : '0px',
            paddingLeft: withinIndentDepth ? `${String(TREE_INDENT_PADDING)}px` : '0px',
          }}
        >
          {addingChild && (
            <li className="py-1">
              <CreatePageForm
                orgId={orgId}
                spaceId={spaceId}
                parentPageId={pageId}
                onDone={() => {
                  setAddingChild(false);
                }}
              />
            </li>
          )}
          {!collapsed &&
            children.map((child) => (
              <PageNode
                key={child.pageId}
                orgId={orgId}
                spaceId={spaceId}
                page={child}
                byParent={byParent}
                selectedPage={selectedPage}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
        </ul>
      )}
    </li>
  );
}

function CreatePageForm({
  orgId,
  spaceId,
  parentPageId,
  onDone,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly parentPageId: PageId | null;
  readonly onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();

  const create = useMutation({
    mutationFn: () => createPage({ spaceId, parentPageId, title }),
    onSuccess: () => {
      invalidatePages(queryClient, orgId, spaceId);
      onDone();
    },
    onError: (error) => {
      toast.failure('The page was not created', error);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim().length === 0) return;
        create.mutate();
      }}
      className="flex gap-1.5"
    >
      <FocusOnMountInput
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        placeholder="Page title"
        className="h-7 flex-1 text-xs"
      />
      <Button type="submit" size="sm" variant="primary" disabled={create.isPending} className="h-7">
        Add
      </Button>
    </form>
  );
}

/** Groups a flat page list by `parentPageId` — the tree is built client-side, the same convention `sidebar.tsx`'s project/board grouping uses. */
function groupByParent(
  pages: readonly PageSummary[],
): ReadonlyMap<string | null, readonly PageSummary[]> {
  const groups = new Map<string | null, PageSummary[]>();
  for (const page of pages) {
    const key = page.parentPageId;
    const bucket = groups.get(key);
    if (bucket) bucket.push(page);
    else groups.set(key, [page]);
  }
  return groups;
}

/* -------------------------------------------------------------------------- *
 * Page panel
 * -------------------------------------------------------------------------- */

function PagePanel({
  orgId,
  spaceId,
  pageId,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
}) {
  const pages = useQuery(pagesQuery(orgId, spaceId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');

  const page = (pages.data ?? []).find((row) => row.pageId === pageId);

  const rename = useMutation({
    mutationFn: (nextTitle: string) => renamePage({ pageId, title: nextTitle }),
    onSuccess: () => {
      invalidatePages(queryClient, orgId, spaceId);
      setEditingTitle(false);
    },
    onError: (error) => {
      toast.failure('The page was not renamed', error);
    },
  });

  const archive = useMutation({
    mutationFn: (restore: boolean) => archivePage({ pageId, restore }),
    onSuccess: () => {
      invalidatePages(queryClient, orgId, spaceId);
    },
    onError: (error) => {
      toast.failure('That did not go through', error);
    },
  });

  if (pages.isPending) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (pages.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorView error={pages.error} title="Could not load this page" />
      </div>
    );
  }

  if (page === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Empty
          title="This page is not available"
          description="It may have been moved, archived, or you may not have access to it."
        />
      </div>
    );
  }

  const isArchived = page.archivedAt !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        {editingTitle ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim().length === 0) return;
              rename.mutate(title);
            }}
            className="flex flex-1 items-end gap-2"
          >
            <div className="flex-1">
              <Field label="Title" htmlFor="page-title">
                <FocusOnMountInput
                  id="page-title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Button type="submit" size="sm" variant="primary" disabled={rename.isPending}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingTitle(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-ink">
              {page.title}
              {isArchived && <Badge className="text-warning">archived</Badge>}
            </h1>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTitle(page.title);
                  setEditingTitle(true);
                }}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  // `restore: true` means "un-archive" — when the page is
                  // NOT currently archived, this button archives it, so the
                  // mutation's `restore` argument is `isArchived` itself,
                  // not its negation. (Caught by an end-to-end smoke test:
                  // the flipped version silently no-oped on every click,
                  // since "restore" on a live page has nothing to undo.)
                  archive.mutate(isArchived);
                }}
                disabled={archive.isPending}
              >
                {isArchived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </>
        )}
      </div>

      <DocsEditor orgId={orgId as OrgId} pageId={pageId} />
    </div>
  );
}
