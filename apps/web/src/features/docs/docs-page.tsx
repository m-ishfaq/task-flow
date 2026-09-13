import { useCallback, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  History,
  Link2,
  LayoutTemplate,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Share2,
} from 'lucide-react';
import type { OrgId, PageId, PageTemplateId, SpaceId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useUi } from '../../lib/ui-store.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { formatRelative } from '../../lib/format.js';
import {
  AvatarStack,
  Badge,
  Button,
  Empty,
  FocusOnMountInput,
  Skeleton,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { orgDetailQuery } from '../org/api.js';
import { useMembers } from '../org/use-members.js';
import { DocsEditor, useDocsPresence, type DocsEditorHandle } from './editor/docs-editor.js';
import { PublishPanel } from './publish-panel.js';
import { VersionHistoryPanel } from './version-history.js';
import { CommentsSuggestionsPanel } from './comments-suggestions.js';
import { TemplatesPanel } from './templates-panel.js';
import { BacklinksPanel } from './backlinks-panel.js';
import {
  archivePage,
  archiveSpace,
  createPage,
  createPageFromTemplate,
  createSpace,
  invalidatePages,
  invalidateSpaces,
  pagesQuery,
  pageTemplatesQuery,
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
 * Nothing here re-derives authorization (CLAUDE.md §8.2): `spaces.list`/
 * `pages.list` already omit anything the caller cannot read. Most controls
 * are still shown unconditionally and let the server answer FORBIDDEN — but
 * `space:create`/`space:manage` are Admin-and-Owner only by role (with
 * `space:manage` also grantable per-space via a tuple), so "+ Space" and a
 * space's own archive/restore are gated on real capabilities instead
 * (`SettingsCapabilities.createSpace` org-wide; `spaces.list`'s own
 * per-space `capabilities.manage`) — reading a boolean the server already
 * computed, not a second authorization decision (Phase 15 §1's sweep;
 * these two used to render for every viewer and let a Member's click come
 * back FORBIDDEN).
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

  const pageOpen = search.space !== undefined && search.page !== undefined;

  /* Same list/detail split as `chat-page.tsx`'s `ChatPage`, driven by the
     same kind of source of truth — the URL, not a separate piece of UI
     state — for the same reason: only one thing gets to say what's on
     screen. See that file's comment for the full reasoning. */
  return (
    <div className="flex h-full min-h-0">
      <SpaceTreePanel
        orgId={orgId}
        selectedSpace={search.space}
        selectedPage={search.page}
        onSelectPage={selectPage}
        hideWhenPageOpen={pageOpen}
      />

      <div
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-y-auto md:block',
          pageOpen ? 'block' : 'hidden md:block',
        )}
      >
        {search.space === undefined || search.page === undefined ? (
          <Empty
            title="No page open"
            description="Pick a page on the left, or create one to get started."
          />
        ) : (
          <PagePanel
            key={search.page}
            orgId={orgId}
            spaceId={search.space}
            pageId={search.page}
            onBack={() => {
              void navigate({ to: '/docs', search: { space: search.space, page: undefined } });
            }}
            onNavigatePage={(pageId) => {
              // Re-checked rather than asserted: `search.space` narrows fine
              // as a direct prop value above, but not through this closure.
              if (search.space === undefined) return;
              selectPage(search.space, pageId);
            }}
          />
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
  hideWhenPageOpen,
}: {
  readonly orgId: string;
  readonly selectedSpace: SpaceId | undefined;
  readonly selectedPage: PageId | undefined;
  readonly onSelectPage: (spaceId: SpaceId, pageId: PageId | undefined) => void;
  /** Below `md`, hidden once a page is open — see `DocsPage`'s comment. */
  readonly hideWhenPageOpen: boolean;
}) {
  const spaces = useQuery({ ...spacesQuery(orgId), enabled: orgId !== '' });
  const canCreateSpace =
    useQuery({ ...orgDetailQuery(orgId), enabled: orgId !== '' }).data?.capabilities.createSpace ===
    true;
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  /* Minimizable exactly like the main sidebar: a `w-64` tree that collapses
     to a `w-12` rail holding just the toggle. State lives in ui-store (the
     same place `sidebarOpen` does) so the collapse survives navigation
     within the session. Desktop-only, like the main sidebar's own collapse —
     see `sidebar.tsx`'s `isDesktop` comment for why a rail state and a
     mobile drawer's open/closed state can't be the same boolean. */
  const isDesktop = useIsDesktop();
  const spacesOpen = useUi((state) => state.docsSpacesOpen) || !isDesktop;
  const toggleSpaces = useUi((state) => state.toggleDocsSpaces);

  const list = spaces.data ?? [];
  const live = list.filter((space) => space.archivedAt === null);
  const archived = list.filter((space) => space.archivedAt !== null);
  const shown = showArchived ? list : live;

  return (
    <aside
      className={cn(
        'shrink-0 flex-col border-r border-line bg-surface-raised transition-[width] duration-(--motion-base) md:flex',
        spacesOpen ? 'md:w-64' : 'md:w-12',
        /* Same list/detail hide as `chat-page.tsx`'s `ChannelListPanel` —
           full width when shown below `md`, `hidden` rather than shrunk to
           nothing when a page is open there. */
        hideWhenPageOpen ? 'hidden' : 'flex w-full',
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line/50 px-2">
        {/* Same uppercase, tracked-out eyebrow `sidebar.tsx`'s own section
            labels already use — the Design Bible's own tree header reads as
            a wiki title, not a plain sub-heading. */}
        {spacesOpen && (
          <h2 className="truncate px-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
            Spaces
          </h2>
        )}
        <div className={cn('flex items-center gap-1', spacesOpen ? 'ml-auto' : 'mx-auto')}>
          {spacesOpen && canCreateSpace && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreatingSpace((open) => !open);
              }}
            >
              {creatingSpace ? (
                'Cancel'
              ) : (
                <>
                  <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
                  Space
                </>
              )}
            </Button>
          )}
          {/* Desktop-rail-only, like the main sidebar's own toggle — see
              `sidebar.tsx`'s equivalent button for why. */}
          {isDesktop && (
            <button
              type="button"
              onClick={toggleSpaces}
              aria-label={spacesOpen ? 'Collapse spaces panel' : 'Expand spaces panel'}
              aria-expanded={spacesOpen}
              className="rounded-lg p-1.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
            >
              {spacesOpen ? (
                <PanelLeftClose aria-hidden="true" className="size-4" strokeWidth={2} />
              ) : (
                <PanelLeftOpen aria-hidden="true" className="size-4" strokeWidth={2} />
              )}
            </button>
          )}
        </div>
      </div>

      {spacesOpen && creatingSpace && (
        <div className="border-b border-line/50 p-2">
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
              className="mt-2 block px-1 text-xs text-ink-faint underline hover:text-ink-muted"
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
  /* Every `PageNode` used to mount already expanded (`useState(false)`),
     regardless of depth or relevance — a real org's tree renders every
     branch open at once, which is the "wall of truncated text" a real
     screenshot showed: five or six levels deep, every sibling branch fanned
     out, nothing to do with what's actually open. Two sources, combined,
     decide what starts expanded instead: every ROOT page's own immediate
     children (an ordinary two-level "Getting Started > Onboarding" list is
     not the problem, and hiding it by default would be worse, not better),
     plus the full ANCESTOR chain of the selected page, however deep it
     goes (reusing `pageAncestors`, the same helper the page panel's own
     breadcrumb walks) — so the active page's own location is always
     visible. Everything else — a sibling branch nobody opened, a deep
     chain with nothing selected in it — starts collapsed, matching how
     Notion/Confluence's own tree behaves rather than a flat unroll. */
  const rootPageIds = (byParent.get(null) ?? []).map((row) => row.pageId);
  const ancestorIds = pageAncestors(live, selectedPage ?? '').map((row) => row.pageId);
  const expandedPageIds = new Set([...rootPageIds, ...ancestorIds]);

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
      <div className="group flex items-center rounded-md hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => {
            setCollapsed((value) => !value);
          }}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${space.name}` : `Collapse ${space.name}`}
          className="flex w-5 shrink-0 items-center justify-center py-1.5 text-ink-faint hover:text-ink"
        >
          {collapsed ? (
            <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
          )}
        </button>

        <button
          type="button"
          onClick={() => {
            setCollapsed((value) => !value);
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left text-xs font-medium',
            isArchived ? 'text-ink-faint' : 'text-ink-muted hover:text-ink',
          )}
          title={space.name}
        >
          <Folder aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.25} />
          <span className="truncate">{space.name}</span>
        </button>

        {isArchived && <Badge className="mr-1 text-warning">archived</Badge>}

        {isArchived ? (
          space.capabilities.manage && (
            <button
              type="button"
              onClick={() => {
                restore.mutate();
              }}
              className="shrink-0 px-1.5 py-1 text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
            >
              Restore
            </button>
          )
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
        <div className="mb-1 ml-5 border-l border-line/50 pl-2">
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
            <p className="py-1 text-xs text-ink-faint">No pages</p>
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
                  expandedPageIds={expandedPageIds}
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
  expandedPageIds,
  onSelect,
  depth,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly page: PageSummary;
  readonly byParent: ReadonlyMap<string | null, readonly PageSummary[]>;
  readonly selectedPage: PageId | undefined;
  /** Ancestors of the selected page — see `SpaceNode`'s own comment. */
  readonly expandedPageIds: ReadonlySet<string>;
  readonly onSelect: (pageId: PageId) => void;
  /** How far from a space root this page sits. Root pages are 0. */
  readonly depth: number;
}) {
  /* Seeded from the ancestor set once, on mount — not re-derived on every
     render, so a person who manually opens a branch keeps it open even
     after selecting a page elsewhere in the tree. */
  const [collapsed, setCollapsed] = useState(() => !expandedPageIds.has(page.pageId));
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
          'group flex items-center rounded-md',
          /* The Design Bible's own `.doc-tree .dt.on` takes the Docs
             module's own suite hue, not a plain hover tint — matching the
             identical fix already applied to the sidebar's own Docs nav
             item and Chat's active channel row. */
          selected ? 'bg-suite-docs/10' : 'hover:bg-surface-hover',
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
            className="flex w-4 shrink-0 items-center justify-center py-1.5 text-ink-faint hover:text-ink"
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" className="size-3" strokeWidth={2.25} />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3" strokeWidth={2.25} />
            )}
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
            'flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left text-xs',
            selected ? 'font-medium text-suite-docs' : 'text-ink-muted hover:text-ink',
          )}
          title={page.title}
        >
          <FileText
            aria-hidden="true"
            className={cn('size-3 shrink-0', selected ? 'text-suite-docs' : 'text-ink-faint')}
            strokeWidth={2}
          />
          <span className="truncate">{page.title}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setAddingChild((value) => !value);
          }}
          aria-label={`New page under ${page.title}`}
          className="shrink-0 p-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink"
        >
          <Plus aria-hidden="true" className="size-3" strokeWidth={2.25} />
        </button>
      </div>

      {(addingChild || (!collapsed && children.length > 0)) && (
        <ul
          className="border-l border-line/50/50"
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
                expandedPageIds={expandedPageIds}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Also offers starting from one of the space's templates (Wave 4, §5) —
 * `templates.createPage` is `pages.createPage` plus seeded content
 * (`template.service.ts`'s own header: "using a template is exactly
 * `pages.create`"), so this form picks which mutation to call rather than
 * the template being a separate flow.
 */
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
  const [templateId, setTemplateId] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();
  const templates = useQuery(pageTemplatesQuery(orgId, spaceId));

  const create = useMutation({
    mutationFn: () =>
      templateId === ''
        ? createPage({ spaceId, parentPageId, title })
        : createPageFromTemplate({
            spaceId,
            parentPageId,
            title,
            templateId: templateId as PageTemplateId,
          }),
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
      className="space-y-1.5"
    >
      <div className="flex gap-1.5">
        <FocusOnMountInput
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          placeholder="Page title"
          className="h-7 flex-1 text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={create.isPending}
          className="h-7"
        >
          Add
        </Button>
      </div>
      {(templates.data ?? []).length > 0 && (
        <select
          value={templateId}
          onChange={(event) => {
            setTemplateId(event.target.value);
          }}
          className="h-7 w-full rounded-md border border-line bg-surface-raised px-1.5 text-xs text-ink-muted"
        >
          <option value="">Blank page</option>
          {(templates.data ?? []).map((template) => (
            <option key={template.templateId} value={template.templateId}>
              {template.name}
            </option>
          ))}
        </select>
      )}
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

/**
 * Every ancestor of `pageId`, ROOT first — walked client-side over the same
 * flat, already-fetched `pages` list `groupByParent` builds the tree from,
 * rather than a second request. This is the Design Bible §08 mockup's own
 * "breadcrumbs" ask: a page nested three deep should say where it lives
 * ("Design system › Foundations"), not just its own title. Deliberately
 * does not include `pageId` itself — its title is already the big `h1`
 * right below, so repeating it as the trail's own last crumb would be the
 * exact "duplicate heading" shape this codebase already fixed once for the
 * app shell (`shell.tsx`'s `breadcrumbsFor`).
 */
function pageAncestors(pages: readonly PageSummary[], pageId: string): readonly PageSummary[] {
  const byId = new Map(pages.map((page) => [page.pageId, page] as const));
  const chain: PageSummary[] = [];
  let current = byId.get(pageId);
  while (current !== undefined && current.parentPageId !== null) {
    const parent = byId.get(current.parentPageId);
    if (parent === undefined) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/**
 * The utility strip below the document body — Publish/Version history/
 * Comments & suggestions/Templates/Backlinks used to render as five
 * always-visible, always-fetching panels stacked with `space-y-6`, which is
 * the literal "rest is beneath that is very simple" complaint: a page of
 * real prose followed by five boxy mini-sections nobody asked to see yet.
 * One tab active at a time — matching `platform-admin-page.tsx`'s own
 * `role="tablist"` icon-strip shape — means only the tab someone actually
 * opens ever fires its query, the same "don't fetch what nobody asked to
 * see" instinct behind Comments' own inner Comments/Suggestions split.
 */
const DOC_TOOLS = [
  ['comments', 'Comments', MessageSquare],
  ['history', 'Version history', History],
  ['publish', 'Publish', Share2],
  ['templates', 'Templates', LayoutTemplate],
  ['backlinks', 'What links here', Link2],
] as const;

type DocTool = (typeof DOC_TOOLS)[number][0];

function PagePanel({
  orgId,
  spaceId,
  pageId,
  onBack,
  onNavigatePage,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
  /** Below `md`, returns to the space tree — see `DocsPage`'s comment. */
  readonly onBack: () => void;
  /** The breadcrumb trail's own navigation — a click on the space name or an ancestor page. `undefined` means "back to the space, no page open". */
  readonly onNavigatePage: (pageId: PageId | undefined) => void;
}) {
  const navigate = useNavigate();
  const pages = useQuery(pagesQuery(orgId, spaceId));
  const spaces = useQuery(spacesQuery(orgId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [editorHandle, setEditorHandle] = useState<DocsEditorHandle | null>(null);
  const [tool, setTool] = useState<DocTool>('comments');
  /* Bumped after a version restore to force `DocsEditor` to remount with a
     fresh Hocuspocus connection — `version-history.tsx`'s own header on why
     a restore is otherwise invisible until the next reload. */
  const [editorGeneration, setEditorGeneration] = useState(0);

  /* Must be stable, or `docs-editor.tsx`'s `onReady` effect re-fires (and
     re-notifies) on every render — see that file's own header. */
  const handleEditorReady = useCallback((handle: DocsEditorHandle | null) => {
    setEditorHandle(handle);
  }, []);

  const page = (pages.data ?? []).find((row) => row.pageId === pageId);
  const spaceName = spaces.data?.find((row) => row.spaceId === spaceId)?.name ?? 'Space';
  const ancestors = pageAncestors(pages.data ?? [], pageId);

  /* Design Bible §08's own "Edited N ago · 2 people here now" line — see
     `useDocsPresence`'s own header for why this hook, not a component, is
     what moved here. `others` excludes the viewer themself — real, but it
     meant "who is live now" showed literally NOTHING for the overwhelming
     common case (nobody else has the page open right now), which is exactly
     the case where a person most needs to SEE the presence feature is
     alive, not just take it on faith. The viewer's own avatar joins the
     roster below so the presence UI is always demonstrably live, matching
     the mockup's own always-visible avatar pair. */
  const others = useDocsPresence(editorHandle?.provider ?? null);
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const presenceRoster = viewerId === null ? others : [personOf(viewerId), ...others];

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

  /* Click-to-edit, not a separate "Rename" form — the mockup's own ask is a
     title that behaves like the rest of a Google Docs page: click it, type,
     it's saved. Skips the mutation entirely for an unchanged or blanked-out
     value rather than round-tripping a no-op write. */
  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed === page.title) {
      setEditingTitle(false);
      return;
    }
    rename.mutate(trimmed);
  };

  return (
    <div className="mx-auto max-w-[85%] space-y-4 p-6">
      {/* The only way back to the space tree below `md` — see `DocsPage`'s
          comment on the list/detail split this belongs to. */}
      <button
        type="button"
        onClick={onBack}
        className="-ml-1.5 flex items-center gap-1 rounded-lg p-1.5 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink md:hidden"
      >
        <span aria-hidden="true">←</span> Spaces
      </button>

      {/* The mockup's own breadcrumb — "Design system › Foundations" above
          the title, at every viewport (unlike the mobile-only ← Spaces link
          just above). The space name is always known once `spaces` has
          loaded; ancestors are only there for a page nested under another
          page. */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px]">
        <button
          type="button"
          onClick={() => {
            onNavigatePage(undefined);
          }}
          className="-mx-1 truncate rounded px-1 text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          {spaceName}
        </button>
        {ancestors.map((ancestor) => (
          <span key={ancestor.pageId} className="flex min-w-0 shrink items-center gap-1">
            <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
            <button
              type="button"
              onClick={() => {
                onNavigatePage(ancestor.pageId as PageId);
              }}
              title={ancestor.title}
              className="-mx-1 truncate rounded px-1 text-ink-faint hover:bg-surface-hover hover:text-ink"
            >
              {ancestor.title}
            </button>
          </span>
        ))}
      </nav>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <FocusOnMountInput
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitTitle();
                } else if (event.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
              aria-label="Page title"
              className="h-auto w-full border-0 bg-transparent px-0 font-display text-3xl font-bold tracking-tight text-ink focus:bg-transparent focus:ring-0"
            />
          ) : (
            /* Click-to-edit, not a separate "Rename" form/button — the
               Design Bible §08 mockup's own ask: a title that behaves like
               the rest of a real document, editable in place. Still a real
               `<h1>` (heading role, accessible name = the title) wrapped in
               a plain clickable button rather than a `contenteditable`
               element, so the actual EDIT still goes through the same
               validated `renamePage` mutation every other rename in this
               app uses — never raw DOM content trusted as the new title. */
            <button
              type="button"
              onClick={() => {
                setTitle(page.title);
                setEditingTitle(true);
              }}
              /* Explicit, distinct from the plain title text: the tree
                 panel's own row for this same page (`PageNode`) is ALSO a
                 button whose accessible name is the bare title, and both
                 can be on screen at once (the desktop layout keeps the tree
                 mounted beside an open page) — an unlabelled button here
                 would be indistinguishable from that unrelated control to
                 anything that queries by accessible name, screen readers
                 included. */
              aria-label={`Rename "${page.title}"`}
              className="group -mx-1.5 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-0.5 text-left hover:bg-surface-hover"
            >
              <h1 className="font-display text-3xl font-bold tracking-tight text-ink">
                {page.title}
                {isArchived && <Badge tone="warning">archived</Badge>}
              </h1>
              <Pencil
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-faint opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100"
                strokeWidth={2}
              />
            </button>
          )}
          {/* "Edited N ago · N people here now" — the mockup's own metadata
              line. `page.updatedAt` is bumped on rename/move/archive, never
              a body edit (the router's own output-schema comment explains
              why), so this is honest about what it can see rather than
              promising a live "last edited" instant no route here actually
              tracks. The headcount now always includes the viewer — see
              `presenceRoster`'s own comment above. */}
          <p className="mt-1 text-xs text-ink-faint">
            Edited {formatRelative(page.updatedAt)}
            {presenceRoster.length > 0 &&
              ` · ${String(presenceRoster.length)} ${presenceRoster.length === 1 ? 'person' : 'people'} here now`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* The mockup's own top-right avatar pair — real faces, not a
              count, the same `AvatarStack` a board card's assignees already
              use. Includes the viewer's own avatar (`presenceRoster`), so
              this is never empty for anyone with the page open. */}
          {presenceRoster.length > 0 && (
            <span title={`Here now: ${presenceRoster.map((person) => person.label).join(', ')}`}>
              <AvatarStack people={presenceRoster} max={4} size="xs" />
            </span>
          )}
          {/* `page:delete` is Admin-and-Owner by role, tuple-shareable
              per page — `page.capabilities.archive` is the server's own
              answer, not a rule re-derived here. Hidden entirely for a
              Member with no grant, rather than shown and left to answer
              FORBIDDEN (Phase 15 §1's sweep). */}
          {page.capabilities.archive && (
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
          )}
        </div>
      </div>

      <DocsEditor
        key={editorGeneration}
        orgId={orgId as OrgId}
        spaceId={spaceId}
        pageId={pageId}
        onReady={handleEditorReady}
      />

      {/* One tool at a time, not five stacked panels — see `DOC_TOOLS`'s own
          header for why. */}
      <div className="space-y-3 border-t border-line pt-4">
        <div role="tablist" aria-label="Page tools" className="flex gap-1 overflow-x-auto">
          {DOC_TOOLS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tool === value}
              onClick={() => {
                setTool(value);
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors duration-(--motion-fast)',
                /* The Docs suite hue, not a generic accent — the same fix
                   already applied to a selected page in the tree and Chat's
                   own active channel row. */
                tool === value
                  ? 'bg-suite-docs/10 text-suite-docs'
                  : 'text-ink-faint hover:bg-surface-hover hover:text-ink',
              )}
            >
              <Icon aria-hidden="true" className="size-3.5" strokeWidth={2} />
              {label}
            </button>
          ))}
        </div>

        {/* `min-h-64` — a real report, not a hypothesis: switching between a
            tall tab (Comments, once a thread or two exists) and a short one
            (Publish, Backlinks on a page nothing links to) collapsed the
            whole panel down to a couple of lines and back, which yanks
            everything below it (nothing here today, but the panel itself)
            and reads as the page reflowing under you. A floor, not a fixed
            height — a genuinely long Comments thread still grows past it. */}
        <div className="min-h-64 rounded-xl border border-line bg-surface-raised p-4">
          {tool === 'comments' && (
            <CommentsSuggestionsPanel orgId={orgId} pageId={pageId} editorHandle={editorHandle} />
          )}
          {tool === 'history' && (
            <VersionHistoryPanel
              orgId={orgId}
              pageId={pageId}
              onRestored={() => {
                setEditorGeneration((generation) => generation + 1);
              }}
            />
          )}
          {tool === 'publish' && (
            <PublishPanel
              orgId={orgId}
              spaceId={spaceId}
              pageId={pageId}
              publishedAt={page.publishedAt}
            />
          )}
          {tool === 'templates' && (
            <TemplatesPanel orgId={orgId} spaceId={spaceId} pageId={pageId} />
          )}
          {tool === 'backlinks' && (
            <BacklinksPanel
              orgId={orgId}
              pageId={pageId}
              onNavigate={(targetSpaceId, targetPageId) => {
                void navigate({
                  to: '/docs',
                  search: { space: targetSpaceId, page: targetPageId },
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
