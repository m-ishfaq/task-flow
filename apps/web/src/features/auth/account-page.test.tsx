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
  profileGetQuery,
  updateProfileMutate,
  logoutEverywhereMutate,
  orgsListQuery,
  passkeysListQuery,
  sessionsListQuery,
  sessionsRevokeMutate,
  signOut,
  navigate,
  disconnectSocket,
  disconnectChatSocket,
  guard,
} = vi.hoisted(() => ({
  meQuery: vi.fn<() => Promise<unknown>>(),
  profileGetQuery: vi.fn<() => Promise<unknown>>(),
  updateProfileMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  logoutEverywhereMutate: vi.fn<() => Promise<unknown>>(),
  orgsListQuery: vi.fn<() => Promise<unknown[]>>(),
  passkeysListQuery: vi.fn<() => Promise<unknown[]>>(),
  sessionsListQuery: vi.fn<() => Promise<unknown>>(),
  sessionsRevokeMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
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
      logoutEverywhere: { mutate: logoutEverywhereMutate },
      passkeys: { list: { query: passkeysListQuery } },
      /* §3.4 — the device inventory lives on this page. */
      sessions: {
        list: { query: sessionsListQuery },
        revoke: { mutate: sessionsRevokeMutate },
      },
    },
    /* Phase 11.5: the display name and the working-hours section now write
       through people.profile — the canonical record. `auth.updateProfile`
       does not exist on the wire any more, so the mock must not either. */
    people: {
      profile: {
        get: { query: profileGetQuery },
        update: { mutate: updateProfileMutate },
      },
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

/* The full merged view the working-hours section reads — everything unset
   except the display name, so the section renders its defaults. */
const PROFILE = {
  ...ME,
  timezone: null,
  workingHoursStart: null,
  workingHoursEnd: null,
  workingDays: null,
  oooFrom: null,
  oooUntil: null,
  oooMessage: null,
};

beforeEach(() => {
  meQuery.mockReset().mockResolvedValue(ME);
  profileGetQuery.mockReset().mockResolvedValue(PROFILE);
  updateProfileMutate.mockReset();
  logoutEverywhereMutate.mockReset();
  orgsListQuery.mockReset().mockResolvedValue([]);
  passkeysListQuery.mockReset().mockResolvedValue([]);
  sessionsListQuery.mockReset().mockResolvedValue({ sessions: [], pushDeviceCount: 0 });
  sessionsRevokeMutate.mockReset().mockResolvedValue({ status: 'revoked' });
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
    /* Exact-name match: the page now also has a "Save working hours" button
       (Phase 11.5), and /save/i would match both. */
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

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

describe('the sessions section (§3.4 device inventory)', () => {
  it('lists every active session with its label, current badge, and unusual-sign-in note', async () => {
    sessionsListQuery.mockResolvedValue({
      sessions: [
        {
          id: 'session_1',
          label: 'Chrome on macOS',
          ip: '1.1.1.1',
          authenticatedAt: '2026-08-10T10:00:00.000Z',
          lastSeenAt: '2026-08-10T12:00:00.000Z',
          isCurrent: true,
          country: 'US',
          flagged: false,
        },
        {
          id: 'session_2',
          label: 'Firefox on Linux',
          ip: '2.2.2.2',
          authenticatedAt: '2026-08-10T09:00:00.000Z',
          lastSeenAt: '2026-08-10T09:30:00.000Z',
          isCurrent: false,
          country: 'FR',
          flagged: true,
        },
      ],
      pushDeviceCount: 1,
    });
    renderPage();

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText(/unusual sign-in from FR/i)).toBeInTheDocument();
    expect(screen.getByText(/push notifications are active on 1 device/i)).toBeInTheDocument();
  });

  it('signs one device out, and a step-up failure re-issues the same revocation', async () => {
    sessionsListQuery.mockResolvedValue({
      sessions: [
        {
          id: 'session_1',
          label: 'Chrome on macOS',
          ip: '1.1.1.1',
          authenticatedAt: '2026-08-10T10:00:00.000Z',
          lastSeenAt: '2026-08-10T12:00:00.000Z',
          isCurrent: false,
          country: null,
          flagged: false,
        },
      ],
      pushDeviceCount: 0,
    });
    renderPage();
    await screen.findByText('Chrome on macOS');

    /* Exact name, not /sign out/i — "Sign out everywhere" would match the
       regex and this query must hit the per-device row button only. */
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(sessionsRevokeMutate).toHaveBeenCalledWith({ sessionId: 'session_1' });
    });

    // A step-up failure routes to the guard, whose retry re-issues the SAME
    // revocation (the session id is the mutation's variable, captured per call).
    const stepUpError = new Error('STEP_UP_REQUIRED');
    sessionsRevokeMutate.mockRejectedValueOnce(stepUpError);
    guard.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(guard).toHaveBeenCalledWith(stepUpError, expect.any(Function));
    });
    const retry = guard.mock.calls[0]?.[1] as () => void;
    retry();
    await waitFor(() => {
      expect(sessionsRevokeMutate).toHaveBeenCalledWith({ sessionId: 'session_1' });
    });
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
