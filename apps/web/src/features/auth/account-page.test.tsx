import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import { ToastContext } from '../../lib/toast-context.js';

/**
 * The personal account page (`ai/account-page.md`).
 *
 * `PasskeySection` is exercised on its own in `passkey-section.test.tsx` and is
 * rendered here unmocked to prove it mounts without an org in context — the
 * bug this whole page exists to fix — but its own state machine is not
 * re-tested. What is new here, and worth its own state-machine coverage: the
 * profile editor now reads from `auth.me` instead of the org member list, and
 * "sign out everywhere" has to run the SAME local cleanup the sidebar's own
 * sign-out does, since the call it wraps revokes the caller's own session too.
 */

/* `vi.hoisted` rather than plain `const`s — see passkey-section.test.tsx for
   why: `../../lib/query.js` (imported below, for `createQueryClient`) imports
   `./trpc.js` and `./session.js` itself, so their mock factories run the
   moment those REAL imports are evaluated, before this file reaches any of
   its own top-level statements. A plain `const meQuery = vi.fn()` referenced
   from a factory would still be in its temporal dead zone at that point. */
const {
  meQuery,
  updateProfileMutate,
  logoutEverywhereMutate,
  orgsListQuery,
  passkeysListQuery,
  signOut,
  navigate,
  disconnectSocket,
  disconnectChatSocket,
  guard,
} = vi.hoisted(() => ({
  meQuery: vi.fn<() => Promise<unknown>>(),
  updateProfileMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  logoutEverywhereMutate: vi.fn<() => Promise<unknown>>(),
  orgsListQuery: vi.fn<() => Promise<unknown[]>>(),
  passkeysListQuery: vi.fn<() => Promise<unknown[]>>(),
  signOut: vi.fn<() => Promise<void>>(),
  navigate: vi.fn(),
  disconnectSocket: vi.fn(),
  disconnectChatSocket: vi.fn(),
  guard: vi.fn<(error: unknown, retry: () => void) => boolean>(() => false),
}));

vi.mock('../../lib/trpc.js', () => ({
  api: {
    auth: {
      me: { query: meQuery },
      updateProfile: { mutate: updateProfileMutate },
      logoutEverywhere: { mutate: logoutEverywhereMutate },
      passkeys: { list: { query: passkeysListQuery } },
    },
    tenancy: {
      orgs: { list: { query: orgsListQuery } },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

vi.mock('../../lib/session.js', () => ({ signOut }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../../lib/socket.js', () => ({ disconnectSocket }));
vi.mock('../../lib/chat-socket.js', () => ({ disconnectChatSocket }));

vi.mock('./use-step-up.js', () => ({
  useStepUp: () => ({ guard, dialog: null }),
}));

const { AccountPage } = await import('./account-page.js');

const toastShow = vi.fn();
const toastFailure = vi.fn();

function renderPage() {
  return render(
    <ToastContext.Provider value={{ show: toastShow, failure: toastFailure }}>
      <QueryClientProvider client={createQueryClient()}>
        <AccountPage />
      </QueryClientProvider>
    </ToastContext.Provider>,
  );
}

const ME = {
  email: 'alice@example.test',
  displayName: 'Alice Doe',
  createdAt: '2026-01-15T00:00:00.000Z',
  emailVerified: true,
};

beforeEach(() => {
  meQuery.mockReset().mockResolvedValue(ME);
  updateProfileMutate.mockReset();
  logoutEverywhereMutate.mockReset();
  orgsListQuery.mockReset().mockResolvedValue([]);
  passkeysListQuery.mockReset().mockResolvedValue([]);
  signOut.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  disconnectSocket.mockReset();
  disconnectChatSocket.mockReset();
  guard.mockReset().mockReturnValue(false);
  toastShow.mockReset();
  toastFailure.mockReset();
});

describe('the profile section', () => {
  it('renders the account, independent of any org', async () => {
    renderPage();

    expect(await screen.findByDisplayValue('Alice Doe')).toBeInTheDocument();
    expect(screen.getByDisplayValue('alice@example.test')).toBeInTheDocument();
    expect(screen.getByText(/email verified/i)).toBeInTheDocument();
    expect(screen.getByText(/member since/i)).toBeInTheDocument();
  });

  it('shows unverified when the account has not confirmed its email', async () => {
    meQuery.mockResolvedValue({ ...ME, emailVerified: false });
    renderPage();

    expect(await screen.findByText(/email not verified/i)).toBeInTheDocument();
  });

  it('saves an edited name', async () => {
    updateProfileMutate.mockResolvedValue({ displayName: 'A. Doe' });
    renderPage();

    const input = await screen.findByDisplayValue('Alice Doe');
    await userEvent.clear(input);
    await userEvent.type(input, 'A. Doe');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(updateProfileMutate).toHaveBeenCalledWith({ displayName: 'A. Doe' });
    });
    expect(toastShow).toHaveBeenCalled();
  });

  it('clears the name with an empty save, rather than sending an empty string', async () => {
    updateProfileMutate.mockResolvedValue({ displayName: null });
    renderPage();

    const input = await screen.findByDisplayValue('Alice Doe');
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(updateProfileMutate).toHaveBeenCalledWith({ displayName: null });
    });
  });
});

describe('signing out everywhere', () => {
  const confirmAndClick = async () => {
    await userEvent.click(screen.getByRole('button', { name: /sign out everywhere/i }));
    await userEvent.click(
      screen.getByRole('button', { name: /sign out of every device, including this one/i }),
    );
  };

  it('runs the full local cleanup on success, same as the sidebar sign-out', async () => {
    logoutEverywhereMutate.mockResolvedValue({ revoked: 3 });
    renderPage();
    await screen.findByDisplayValue('Alice Doe');

    await confirmAndClick();

    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
    expect(disconnectSocket).toHaveBeenCalled();
    expect(disconnectChatSocket).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/login' });
  });

  it('routes a step-up failure to the guard, and its retry re-issues the call', async () => {
    const stepUpError = new Error('STEP_UP_REQUIRED');
    logoutEverywhereMutate.mockRejectedValueOnce(stepUpError).mockResolvedValue({ revoked: 1 });
    guard.mockReturnValue(true);
    renderPage();
    await screen.findByDisplayValue('Alice Doe');

    await confirmAndClick();

    await waitFor(() => {
      expect(guard).toHaveBeenCalledWith(stepUpError, expect.any(Function));
    });
    expect(signOut).not.toHaveBeenCalled();
    expect(toastFailure).not.toHaveBeenCalled();

    const retry = guard.mock.calls[0]?.[1] as () => void;
    retry();

    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
  });

  it('toasts a failure the guard does not claim', async () => {
    logoutEverywhereMutate.mockRejectedValue(new Error('nope'));
    guard.mockReturnValue(false);
    renderPage();
    await screen.findByDisplayValue('Alice Doe');

    await confirmAndClick();

    await waitFor(() => {
      expect(toastFailure).toHaveBeenCalled();
    });
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe('the organizations section', () => {
  it('lists every org the caller belongs to, with its role', async () => {
    orgsListQuery.mockResolvedValue([
      { orgId: 'org_1', name: 'Acme', slug: 'acme', role: 'owner' },
      { orgId: 'org_2', name: 'Widgets Co', slug: 'widgets', role: 'member' },
    ]);
    renderPage();

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('Widgets Co')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
  });

  it('offers a way to join or create one when there are none yet', async () => {
    orgsListQuery.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText(/no organizations yet/i)).toBeInTheDocument();
  });
});
