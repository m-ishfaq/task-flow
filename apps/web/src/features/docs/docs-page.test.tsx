import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
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
}

const listSpaces = vi.fn<() => Promise<SpaceListItem[]>>();
const listPages = vi.fn<(input: { spaceId: string }) => Promise<PageListItem[]>>();
const archivePageMutate = vi.fn<(input: { pageId: string; restore: boolean }) => Promise<unknown>>();
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
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
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
    },
    {
      pageId: CHILD_PAGE_ID,
      parentPageId: ROOT_PAGE_ID,
      title: 'Onboarding',
      rank: 'a0',
      archivedAt: null,
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
