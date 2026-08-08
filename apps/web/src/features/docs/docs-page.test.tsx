import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { useUi } from '../../lib/ui-store.js';
import { ToastProvider } from '../../components/toast.js';

/**
 * The space/page tree and page panel (ai/phase-6-docs.md §5, Wave 1 of the
 * UI), mirroring `verify-email-page.test.tsx`'s approach: the router and the
 * tRPC client are both stubbed, because this is a test about what the
 * component does with a resolved query, not whether TanStack Router or tRPC
 * themselves work.
 *
 * Written to lock in a real bug an end-to-end smoke test caught that
 * typecheck and lint both missed: the Archive/Restore button computed its
 * `restore` argument as `!isArchived` instead of `isArchived`, so clicking
 * "Archive" actually called `pages.archive.mutate({ restore: true })` — a
 * silent no-op, since there was nothing to restore. The bug produced no
 * type error and no lint warning because both booleans are the same TYPE;
 * only asserting on the ACTUAL argument the mutation receives catches it.
 */

interface SpaceListItem {
  spaceId: string;
  name: string;
  archivedAt: string | null;
}

interface PageListItem {
  pageId: string;
  parentPageId: string | null;
  title: string;
  rank: string;
  archivedAt: string | null;
  publishedAt: string | null;
}

const listSpaces = vi.fn<() => Promise<SpaceListItem[]>>();
const listPages = vi.fn<(input: { spaceId: string }) => Promise<PageListItem[]>>();
const archivePageMutate =
  vi.fn<(input: { pageId: string; restore: boolean }) => Promise<unknown>>();
const navigate = vi.fn();

let search: { space: string | undefined; page: string | undefined } = {
  space: undefined,
  page: undefined,
};

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  useNavigate: () => navigate,
}));

vi.mock('../../lib/trpc.js', () => ({
  api: {
    docs: {
      spaces: {
        list: { query: () => listSpaces() },
        create: { mutate: vi.fn() },
        archive: { mutate: vi.fn() },
      },
      pages: {
        list: { query: (input: { spaceId: string }) => listPages(input) },
        create: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        archive: {
          mutate: (input: { pageId: string; restore: boolean }) => archivePageMutate(input),
        },
        publish: { mutate: vi.fn() },
        unpublish: { mutate: vi.fn() },
        exportPdf: { mutate: vi.fn() },
      },
      /* PagePanel now also renders the Wave 2-4 tool panels below the
         editor (`publish-panel.tsx`, `version-history.tsx`,
         `comments-suggestions.tsx`, `templates-panel.tsx`,
         `backlinks-panel.tsx`) — each fires its own list query on mount, so
         every one of these needs a stub or the "archiving and restoring a
         page" tests below fail on `Cannot read properties of undefined`
         rather than on anything about archiving. Empty lists render each
         panel's own `Empty` state, which is not asserted on here. */
      pageVersions: {
        list: { query: () => Promise.resolve([]) },
        save: { mutate: vi.fn() },
        restore: { mutate: vi.fn() },
      },
      comments: {
        list: { query: () => Promise.resolve([]) },
        create: { mutate: vi.fn() },
        update: { mutate: vi.fn() },
        resolve: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
      },
      suggestions: {
        list: { query: () => Promise.resolve([]) },
        create: { mutate: vi.fn() },
        decide: { mutate: vi.fn() },
      },
      templates: {
        list: { query: () => Promise.resolve([]) },
        create: { mutate: vi.fn() },
        delete: { mutate: vi.fn() },
        createPage: { mutate: vi.fn() },
      },
      backlinks: {
        list: { query: () => Promise.resolve([]) },
      },
    },
    /* `comments-suggestions.tsx` and `version-history.tsx` both resolve
       author ids through `useMembers()`, which reads `tenancy.members.list`
       — nothing to do with Docs, but still a real call this mock must
       answer or the same panels crash on mount. */
    tenancy: {
      members: {
        list: { query: () => Promise.resolve([]) },
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

/* Selecting a page renders `DocsEditor`, which owns a HocuspocusProvider
   WebSocket — not something a jsdom test about the tree should start, and
   the editor's own wiring has its own suite (editor/docs-editor.test.tsx).
   Wave 1's tests here are about the tree and the archive/restore argument;
   a placeholder keeps them focused on exactly that. */
vi.mock('./editor/docs-editor.js', () => ({
  DocsEditor: () => <div data-testid="docs-editor" />,
}));

const { DocsPage } = await import('./docs-page.js');

const ORG_ID = '019faee8-0000-7000-8000-0000000000f0';
const SPACE_ID = '019faee8-0000-7000-8000-000000000001';
const ROOT_PAGE_ID = '019faee8-0000-7000-8000-000000000002';
const CHILD_PAGE_ID = '019faee8-0000-7000-8000-000000000003';

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <DocsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listSpaces.mockReset();
  listPages.mockReset();
  archivePageMutate.mockReset();
  navigate.mockReset();
  search = { space: undefined, page: undefined };

  /* `docsSpacesOpen` lives in the zustand ui-store, which is NOT reset by
     cleanup — a previous test collapsing the panel would leak into the next
     one and the tree would silently fail to render. */
  useUi.setState({ docsSpacesOpen: true });

  useSession.setState({
    status: 'authenticated',
    accessToken: 'token',
    expiresAt: Date.now() + 600_000,
    sessionId: 'session',
    orgId: ORG_ID as never,
    email: null,
  });

  listSpaces.mockResolvedValue([{ spaceId: SPACE_ID, name: 'Handbook', archivedAt: null }]);
  listPages.mockResolvedValue([
    {
      pageId: ROOT_PAGE_ID,
      parentPageId: null,
      title: 'Getting Started',
      rank: 'a0',
      archivedAt: null,
      publishedAt: null,
    },
    {
      pageId: CHILD_PAGE_ID,
      parentPageId: ROOT_PAGE_ID,
      title: 'Onboarding',
      rank: 'a0',
      archivedAt: null,
      publishedAt: null,
    },
  ]);
});

describe('the tree', () => {
  it('renders spaces, and pages nested under their parent once expanded', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Handbook')).toBeInTheDocument();
    });

    // Pages load only once the space is expanded (`pagesQuery`'s `enabled`).
    expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();

    await user.click(screen.getByText('Handbook'));

    await waitFor(() => {
      expect(screen.getByText('Getting Started')).toBeInTheDocument();
    });
    // The child renders too — grouping by parentPageId worked.
    expect(screen.getByText('Onboarding')).toBeInTheDocument();
  });

  it('collapses to a rail and expands back, like the main sidebar', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Handbook')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Collapse spaces panel' }));

    // The rail hides the tree — the toggle is the only thing left.
    expect(screen.queryByText('Handbook')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand spaces panel' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand spaces panel' }));

    await waitFor(() => {
      expect(screen.getByText('Handbook')).toBeInTheDocument();
    });
  });

  it('renders a deeply nested chain with the TOTAL indent capped so the innermost page stays visible', async () => {
    const user = userEvent.setup();
    const pages: PageListItem[] = [];
    let parent: string | null = null;
    for (let level = 1; level <= 10; level += 1) {
      const pageId = `019faee8-0000-7000-8000-${String(level).padStart(12, '0')}`;
      pages.push({
        pageId,
        parentPageId: parent,
        title: `Level ${String(level)}`,
        rank: 'a0',
        archivedAt: null,
        publishedAt: null,
      });
      parent = pageId;
    }
    listPages.mockResolvedValue(pages);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Handbook')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Handbook'));

    await waitFor(() => {
      expect(screen.getByText('Level 1')).toBeInTheDocument();
    });
    // Ten levels deep, the innermost page still renders.
    expect(screen.getByText('Level 10')).toBeInTheDocument();

    /* The indent is the SUM of every ancestor ul's margin + padding, so a
       cap on each level's OWN contribution is not a cap at all — the levels
       pile up (24 + 48 + 72 + ...) and a leaf six deep ends up ~500px right
       of the tree root. Walk up the whole chain and total the ul
       contributions: it must be exactly the six 16px steps the cap allows
       (96px), and deeper levels must add nothing. The previous version of
       this test only inspected the innermost ul, which is exactly why the
       accumulation bug sailed through CI. */
    let total = 0;
    let node: Element | null = screen.getByText('Level 10').closest('ul');
    while (node !== null) {
      const styles = node instanceof HTMLElement ? node.style : null;
      /* `??` handles a non-HTMLElement ancestor; `|| 0` also catches the
         empty string `style.marginLeft` returns for unstyled elements,
         where parseFloat is NaN. */
      total +=
        (Number.parseFloat(styles?.marginLeft ?? '0') || 0) +
        (Number.parseFloat(styles?.paddingLeft ?? '0') || 0);
      node = node.parentElement;
    }
    expect(total).toBe(96);

    // The deepest ul contributes nothing — the chain sits AT the cap, not
    // past it.
    expect(screen.getByText('Level 10').closest('ul')).toHaveStyle({
      'margin-left': '0px',
      'padding-left': '0px',
    });
  });
});

describe('archiving and restoring a page', () => {
  it('archiving calls the mutation with restore: false, not true', async () => {
    search = { space: SPACE_ID, page: ROOT_PAGE_ID };
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Getting Started' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(archivePageMutate).toHaveBeenCalledWith({ pageId: ROOT_PAGE_ID, restore: false });
    });
  });

  it('restoring an already-archived page calls the mutation with restore: true', async () => {
    search = { space: SPACE_ID, page: ROOT_PAGE_ID };
    listPages.mockResolvedValue([
      {
        pageId: ROOT_PAGE_ID,
        parentPageId: null,
        title: 'Getting Started',
        rank: 'a0',
        archivedAt: '2026-08-01T00:00:00.000Z',
        publishedAt: null,
      },
    ]);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      // The archived badge is a sibling text node inside the same <h1>, so
      // the accessible name is "Getting Started archived" here, not "Getting
      // Started" alone — match the substring rather than the exact string.
      expect(screen.getByRole('heading', { name: /Getting Started/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(archivePageMutate).toHaveBeenCalledWith({ pageId: ROOT_PAGE_ID, restore: true });
    });
  });
});
