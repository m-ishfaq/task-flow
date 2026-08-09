import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createQueryClient } from '../../lib/query.js';

/**
 * Where every OAuth redirect lands (Phase 12 Wave 2 §3.3).
 *
 * Three states this page has to land in distinctly, plus one regression:
 *
 *   - a malformed callback (no code/state, or `error=` from a declined
 *     consent screen) must say so WITHOUT calling the API — there is
 *     nothing to exchange
 *   - a `session` result adopts it and leaves for the app
 *   - a `linked` result leaves for `/account` with no session adopted —
 *     this page never had one to begin with (see the component's own header)
 *   - StrictMode's double-effect must not spend the single-use
 *     authorization `code` twice, the same regression class
 *     `verify-email-page.test.tsx` guards for its own single-use token
 */

const { callbackMutate, adopt, navigate } = vi.hoisted(() => ({
  callbackMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
  adopt: vi.fn(),
  navigate: vi.fn(),
}));

const params: { provider: string } = { provider: 'google' };
const search: { code?: string; state?: string; error?: string } = {
  code: 'auth-code-1',
  state: 'signed-state-1',
};

vi.mock('@tanstack/react-router', () => ({
  useParams: () => params,
  useSearch: () => search,
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('../../lib/trpc.js', () => ({
  api: { auth: { oauth: { callback: { mutate: callbackMutate } } } },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

vi.mock('../../lib/session.js', () => ({
  useSession: (selector: (state: { adopt: typeof adopt }) => unknown) => selector({ adopt }),
}));

const { OAuthCallbackPage } = await import('./oauth-callback-page.js');

function renderPage() {
  return render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <OAuthCallbackPage />
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  callbackMutate.mockReset();
  adopt.mockReset();
  navigate.mockReset();
  params.provider = 'google';
  search.code = 'auth-code-1';
  search.state = 'signed-state-1';
  delete search.error;
});

describe('a malformed callback', () => {
  it('explains a missing code/state without calling the API', async () => {
    delete search.code;
    delete search.state;
    renderPage();

    expect(await screen.findByText(/incomplete/i)).toBeInTheDocument();
    expect(callbackMutate).not.toHaveBeenCalled();
  });

  it("explains the provider's own error without calling the API", async () => {
    search.error = 'access_denied';
    renderPage();

    expect(await screen.findByText(/access_denied/)).toBeInTheDocument();
    expect(callbackMutate).not.toHaveBeenCalled();
  });

  it('never shows the generic ErrorView fallback for a locally-known reason', async () => {
    // The regression this exists for: a plain client-side Error rendered
    // through ErrorView collapses to a fixed fallback string (§8.7 — the
    // shown message must come from the server or a fixed table, never be
    // assembled from an exception), silently swallowing this page's own
    // "incomplete" / "did not complete" wording underneath it.
    delete search.code;
    delete search.state;
    renderPage();

    await screen.findByText(/incomplete/i);
    expect(screen.queryByText(/did not say what/i)).not.toBeInTheDocument();
  });
});

describe('a session outcome', () => {
  it('adopts the session and leaves the OAuth flow entirely', async () => {
    const session = { kind: 'session', accessToken: 'tok', expiresInSeconds: 600, sessionId: 's1' };
    callbackMutate.mockResolvedValue(session);
    renderPage();

    await waitFor(() => {
      expect(adopt).toHaveBeenCalledWith(session);
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });
});

describe('a linked outcome', () => {
  it('navigates to the account page without adopting anything', async () => {
    callbackMutate.mockResolvedValue({ kind: 'linked', provider: 'google' });
    renderPage();

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: '/account' });
    });
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe('a real server failure', () => {
  it('shows it through the ordinary ErrorView path', async () => {
    callbackMutate.mockRejectedValue(new Error('INVALID_STATE'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('StrictMode', () => {
  it('exchanges the authorization code exactly once', async () => {
    const session = { kind: 'session', accessToken: 'tok', expiresInSeconds: 600, sessionId: 's1' };
    callbackMutate.mockResolvedValue(session);
    renderPage();

    await waitFor(() => {
      expect(adopt).toHaveBeenCalled();
    });
    expect(callbackMutate).toHaveBeenCalledTimes(1);
    expect(callbackMutate).toHaveBeenCalledWith({
      provider: 'google',
      code: 'auth-code-1',
      state: 'signed-state-1',
    });
  });
});
