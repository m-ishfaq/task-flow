import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';

/**
 * Connected OAuth accounts (Phase 12 Wave 2 §3.3).
 *
 * `providers` and `listConnected` are both queries this section reads; the
 * available-to-link set is the DIFFERENCE between them, which is the one
 * piece of real logic here worth testing directly rather than trusting the
 * JSX — a provider that is configured server-side but already linked must
 * not offer a second "Connect" button, and one that is not configured must
 * never offer a button at all regardless of link state.
 *
 * `startLink`/`unlink` are both `stepUp: true` server-side; the guard
 * coverage here mirrors `passkey-section.test.tsx`'s own for `remove`.
 */

const { providersQuery, listConnectedQuery, startLinkMutate, unlinkMutate, guard } = vi.hoisted(
  () => ({
    providersQuery: vi.fn<() => Promise<{ google: boolean; github: boolean }>>(),
    listConnectedQuery: vi.fn<() => Promise<unknown[]>>(),
    startLinkMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
    unlinkMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
    guard: vi.fn<(error: unknown, retry: () => void) => boolean>(() => false),
  }),
);

vi.mock('../../lib/trpc.js', () => ({
  api: {
    auth: {
      oauth: {
        providers: { query: providersQuery },
        listConnected: { query: listConnectedQuery },
        startLink: { mutate: startLinkMutate },
        unlink: { mutate: unlinkMutate },
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

vi.mock('./use-step-up.js', () => ({
  useStepUp: () => ({ guard, dialog: null }),
}));

/* `window.location.href` assignment is how `redirectToAuthorization` leaves
   the app — jsdom throws "Not implemented: navigation" on a real assignment,
   so the setter itself is what this file spies on. */
const locationAssign = vi.fn();
Object.defineProperty(window, 'location', {
  value: {
    get href() {
      return '';
    },
    set href(url: string) {
      locationAssign(url);
    },
  },
  writable: true,
});

const { ConnectedAccountsSection } = await import('./connected-accounts-section.js');

function renderSection() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectedAccountsSection />
    </QueryClientProvider>,
  );
}

const GOOGLE_LINK = {
  provider: 'google' as const,
  email: 'alice@gmail.example',
  linkedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  providersQuery.mockReset();
  listConnectedQuery.mockReset();
  startLinkMutate.mockReset();
  unlinkMutate.mockReset();
  guard.mockReset().mockReturnValue(false);
  locationAssign.mockReset();
});

describe('the connected accounts list', () => {
  it('renders a linked provider with its captured email', async () => {
    providersQuery.mockResolvedValue({ google: true, github: false });
    listConnectedQuery.mockResolvedValue([GOOGLE_LINK]);
    renderSection();

    expect(await screen.findByText('Google')).toBeInTheDocument();
    expect(screen.getByText(/alice@gmail\.example/)).toBeInTheDocument();
  });

  it('offers no connect button for an unconfigured provider', async () => {
    providersQuery.mockResolvedValue({ google: false, github: false });
    listConnectedQuery.mockResolvedValue([]);
    renderSection();

    expect(await screen.findByText(/no providers available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect google/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect github/i })).not.toBeInTheDocument();
  });

  it('offers a connect button only for a configured, not-yet-linked provider', async () => {
    // Both configured; only google already linked — github is the one that
    // should still offer a "Connect" button.
    providersQuery.mockResolvedValue({ google: true, github: true });
    listConnectedQuery.mockResolvedValue([GOOGLE_LINK]);
    renderSection();

    await screen.findByText('Google');
    expect(screen.queryByRole('button', { name: /connect google/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect github/i })).toBeInTheDocument();
  });
});

describe('connecting a provider', () => {
  it('redirects to the authorization URL the server returns', async () => {
    providersQuery.mockResolvedValue({ google: false, github: true });
    listConnectedQuery.mockResolvedValue([]);
    startLinkMutate.mockResolvedValue({ authorizationUrl: 'https://github.example/authorize' });
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /connect github/i }));

    await waitFor(() => {
      expect(startLinkMutate).toHaveBeenCalledWith({ provider: 'github' });
    });
    await waitFor(() => {
      expect(locationAssign).toHaveBeenCalledWith('https://github.example/authorize');
    });
  });

  it("routes a STEP_UP_REQUIRED failure to the guard, and the guard's retry re-issues the same link", async () => {
    providersQuery.mockResolvedValue({ google: false, github: true });
    listConnectedQuery.mockResolvedValue([]);
    const stepUpError = new Error('STEP_UP_REQUIRED');
    startLinkMutate
      .mockRejectedValueOnce(stepUpError)
      .mockResolvedValue({ authorizationUrl: 'https://github.example/authorize' });
    guard.mockReturnValue(true);
    renderSection();

    await userEvent.click(await screen.findByRole('button', { name: /connect github/i }));

    await waitFor(() => {
      expect(guard).toHaveBeenCalledWith(stepUpError, expect.any(Function));
    });
    expect(locationAssign).not.toHaveBeenCalled();

    const retry = guard.mock.calls[0]?.[1] as () => void;
    retry();

    await waitFor(() => {
      expect(startLinkMutate).toHaveBeenNthCalledWith(2, { provider: 'github' });
    });
  });
});

describe('unlinking a provider', () => {
  it('confirms before unlinking', async () => {
    providersQuery.mockResolvedValue({ google: true, github: false });
    listConnectedQuery.mockResolvedValue([GOOGLE_LINK]);
    renderSection();

    const row = (await screen.findByText('Google')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^unlink$/i }));
    expect(unlinkMutate).not.toHaveBeenCalled();

    await userEvent.click(within(row).getByRole('button', { name: /unlink google/i }));
    await waitFor(() => {
      expect(unlinkMutate).toHaveBeenCalledWith({ provider: 'google' });
    });
  });

  it("routes a STEP_UP_REQUIRED failure to the guard, and the guard's retry re-issues the same unlink", async () => {
    providersQuery.mockResolvedValue({ google: true, github: false });
    listConnectedQuery.mockResolvedValue([GOOGLE_LINK]);
    const stepUpError = new Error('STEP_UP_REQUIRED');
    unlinkMutate.mockRejectedValueOnce(stepUpError).mockResolvedValue({ status: 'unlinked' });
    guard.mockReturnValue(true);
    renderSection();

    const row = (await screen.findByText('Google')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^unlink$/i }));
    await userEvent.click(within(row).getByRole('button', { name: /unlink google/i }));

    await waitFor(() => {
      expect(guard).toHaveBeenCalledWith(stepUpError, expect.any(Function));
    });
    expect(unlinkMutate).toHaveBeenCalledTimes(1);

    const retry = guard.mock.calls[0]?.[1] as () => void;
    retry();

    await waitFor(() => {
      expect(unlinkMutate).toHaveBeenCalledTimes(2);
    });
    expect(unlinkMutate).toHaveBeenNthCalledWith(2, { provider: 'google' });
  });

  it('shows an inline error for a failure the step-up guard does not claim', async () => {
    providersQuery.mockResolvedValue({ google: true, github: false });
    listConnectedQuery.mockResolvedValue([GOOGLE_LINK]);
    unlinkMutate.mockRejectedValue(new Error('This is the only way to sign in to this account.'));
    guard.mockReturnValue(false);
    renderSection();

    const row = (await screen.findByText('Google')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^unlink$/i }));
    await userEvent.click(within(row).getByRole('button', { name: /unlink google/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
