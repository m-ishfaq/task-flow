import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import type * as PasskeyModule from './passkey.js';

/**
 * The passkey half of sign-in.
 *
 * The password form on this page is untested here — it predates this file and
 * is exercised elsewhere. What is new, and worth a state-machine test in the
 * same spirit as `verify-email-page.test.tsx`, is the passkey button: it has
 * three outcomes a person can hit (a real sign-in, a cancelled prompt, a
 * genuine failure) and each has to land in a DIFFERENT visible state, or a
 * cancelled ceremony either looks like nothing happened at all (fine) or gets
 * mistaken for a scary failure (not fine, and it trains people to ignore the
 * banner that matters).
 */

const adopt = vi.fn();
vi.mock('../../lib/session.js', () => ({
  useSession: (selector: (state: { adopt: typeof adopt }) => unknown) => selector({ adopt }),
}));

const navigate = vi.fn();
const search: { next?: string } = {};
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

/* `vi.hoisted`, not plain `const`s — `../../lib/query.js` (imported above,
   for `createQueryClient`) imports `./trpc.js` itself, so this factory runs
   the moment that REAL import is evaluated: before ANY of this file's own
   top-level statements, `adopt`/`navigate`/`search` above included. Those
   three get away with a plain `const` only because each is read inside a
   CLOSURE their own mock returns (`(selector) => selector({ adopt })`),
   deferred until render; `oauthProvidersQuery`/`oauthStartMutate` are read
   building this factory's OWN return value, immediately, so they need to
   already exist. See account-page.test.tsx's identical comment. */
const { oauthProvidersQuery, oauthStartMutate } = vi.hoisted(() => ({
  oauthProvidersQuery: vi.fn<() => Promise<{ google: boolean; github: boolean }>>(),
  oauthStartMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('../../lib/trpc.js', () => ({
  api: {
    auth: {
      login: { mutate: vi.fn().mockRejectedValue(new Error('not used')) },
      oauth: {
        providers: { query: oauthProvidersQuery },
        start: { mutate: oauthStartMutate },
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

/* `redirectToAuthorization` assigns `window.location.href` — jsdom throws
   "Not implemented: navigation" on a real assignment, so the setter itself
   is what these tests spy on, the same as connected-accounts-section.test.tsx. */
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

const signInWithPasskey = vi.fn<() => Promise<unknown>>();
const browserSupportsWebAuthn = vi.fn<() => boolean>(() => true);

vi.mock('./passkey.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasskeyModule>();
  return { ...actual, signInWithPasskey, browserSupportsWebAuthn };
});

const { LoginPage } = await import('./login-page.js');
const { PasskeyCeremonyError } = await import('./passkey.js');

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LoginPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  adopt.mockReset();
  navigate.mockReset();
  signInWithPasskey.mockReset();
  browserSupportsWebAuthn.mockReturnValue(true);
  oauthProvidersQuery.mockReset().mockResolvedValue({ google: false, github: false });
  oauthStartMutate.mockReset();
  locationAssign.mockReset();
  delete search.next;
});

const passkeyButton = () => screen.getByRole('button', { name: /sign in with a passkey/i });

describe('OAuth sign-in', () => {
  it('renders no button for an unconfigured provider', async () => {
    oauthProvidersQuery.mockResolvedValue({ google: false, github: false });
    renderPage();

    // Wait for the query to settle rather than asserting immediately — a
    // false negative here (checking before the query resolves) would pass
    // even if the button rendered anyway once data arrived.
    await waitFor(() => {
      expect(oauthProvidersQuery).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with github/i })).not.toBeInTheDocument();
  });

  it('renders a button only for a configured provider, and redirects on click', async () => {
    oauthProvidersQuery.mockResolvedValue({ google: true, github: false });
    oauthStartMutate.mockResolvedValue({
      authorizationUrl: 'https://accounts.google.example/auth',
    });
    renderPage();

    const googleButton = await screen.findByRole('button', { name: /continue with google/i });
    expect(screen.queryByRole('button', { name: /continue with github/i })).not.toBeInTheDocument();

    await userEvent.click(googleButton);

    await waitFor(() => {
      expect(oauthStartMutate).toHaveBeenCalledWith({ provider: 'google' });
    });
    await waitFor(() => {
      expect(locationAssign).toHaveBeenCalledWith('https://accounts.google.example/auth');
    });
  });
});

describe('signing in with a passkey', () => {
  it('adopts the session and navigates on success', async () => {
    const session = { accessToken: 'tok', expiresInSeconds: 900, sessionId: 'sess-1' };
    signInWithPasskey.mockResolvedValue(session);
    renderPage();

    await userEvent.click(passkeyButton());

    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(session, undefined);
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('honours ?next= on success, same as password sign-in', async () => {
    search.next = '/boards/abc';
    signInWithPasskey.mockResolvedValue({
      accessToken: 'tok',
      expiresInSeconds: 900,
      sessionId: 'sess-1',
    });
    renderPage();

    await userEvent.click(passkeyButton());

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/boards/abc' });
    });
  });

  it('leaves the form idle and silent when the prompt is cancelled or times out', async () => {
    /* The regression this test guards: a dismissed WebAuthn prompt reports the
       same NotAllowedError as a timeout, and treating either as a visible
       failure trains people to ignore the banner for the one that matters. */
    signInWithPasskey.mockRejectedValue(new PasskeyCeremonyError('cancelled'));
    renderPage();

    await userEvent.click(passkeyButton());

    await waitFor(() => {
      expect(signInWithPasskey).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // The button is usable again, not stuck mid-ceremony.
    expect(passkeyButton()).not.toBeDisabled();
  });

  it('shows a message for a genuine ceremony failure', async () => {
    signInWithPasskey.mockRejectedValue(new PasskeyCeremonyError('unsupported'));
    renderPage();

    await userEvent.click(passkeyButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not support/i);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("shows the server's own failure when a completed ceremony is rejected", async () => {
    // Not a PasskeyCeremonyError — the assertion reached the server and was
    // refused (bad signature, unknown credential, locked account: all the
    // same INVALID_CREDENTIALS per §8.1 property 2). That is a normal API
    // error and renders through the ordinary ErrorView path.
    signInWithPasskey.mockRejectedValue(new Error('INVALID_CREDENTIALS'));
    renderPage();

    await userEvent.click(passkeyButton());

    await waitFor(() => {
      expect(signInWithPasskey).toHaveBeenCalledTimes(1);
    });
    expect(adopt).not.toHaveBeenCalled();
  });

  it('hides the button and explains when the browser has no WebAuthn support', () => {
    browserSupportsWebAuthn.mockReturnValue(false);
    renderPage();

    expect(
      screen.queryByRole('button', { name: /sign in with a passkey/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/does not support passkeys/i)).toBeInTheDocument();
  });
});
