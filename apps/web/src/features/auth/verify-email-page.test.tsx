import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createQueryClient } from '../../lib/query.js';

/**
 * The page an emailed verification link lands on.
 *
 * Written after it was reported stuck on "Confirming…" with no next state. The
 * three things that can go wrong here are all invisible from the server side:
 *
 *   - the mutation never settles, so the spinner is permanent
 *   - StrictMode fires the effect twice, spending a SINGLE-USE token and
 *     rendering the second call's failure over the first call's success
 *   - a failure renders nothing at all, which looks identical to still loading
 *
 * The router and the tRPC client are both stubbed: this is a test about what the
 * component does with a resolved or rejected promise, and routing through either
 * real one would only prove that they work.
 */

const verifyEmail = vi.fn<(input: { token: string }) => Promise<{ status: string }>>();
const search = { token: 'tf_ev_a-real-looking-token' as string | undefined };

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('../../lib/trpc.js', () => ({
  api: { auth: { verifyEmail: { mutate: (input: { token: string }) => verifyEmail(input) } } },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

const { VerifyEmailPage } = await import('./verify-email-page.js');

function renderPage() {
  return render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <VerifyEmailPage />
      </QueryClientProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  verifyEmail.mockReset();
  search.token = 'tf_ev_a-real-looking-token';
});

const confirmButton = () => screen.getByRole('button', { name: /confirm my email|try again/i });

describe('verifying an emailed link', () => {
  it('does nothing until the user asks it to', async () => {
    /* The whole point of the click. Mail security gateways and link previewers
       follow URLs, some executing JavaScript — and this token is SINGLE-USE, so
       a page that confirms on load lets a scanner spend it before the human
       arrives, with no recovery but registering again. */
    verifyEmail.mockResolvedValue({ status: 'verified' });
    renderPage();

    expect(await screen.findByText(/confirm that you own this address/i)).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it('reaches a success state rather than spinning forever', async () => {
    verifyEmail.mockResolvedValue({ status: 'verified' });
    renderPage();

    await userEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByText(/your email address is confirmed/i)).toBeInTheDocument();
    });
    // The spinner must be GONE, not merely joined by the result.
    expect(screen.queryByText(/confirming/i)).not.toBeInTheDocument();
  });

  it('reaches an error state rather than spinning forever', async () => {
    /* The reported symptom was a permanent "Confirming…". A settled mutation has
       to land somewhere a user can act on — a spinner that never resolves is
       indistinguishable from a hung network. */
    verifyEmail.mockRejectedValue(new Error('nope'));
    renderPage();

    await userEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByText(/that link did not work/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/confirming/i)).not.toBeInTheDocument();
    expect(screen.getByText(/single-use and expire/i)).toBeInTheDocument();
  });

  it('spends the token exactly once per click, under StrictMode', async () => {
    /**
     * The regression this file exists for.
     *
     * The first version called `mutate()` from a `useEffect`. StrictMode mounts,
     * unmounts and remounts, so the call happened on a mount React then threw
     * away — along with the mutation observer that would have received the
     * result. The request succeeded and was delivered to nobody; the page hung
     * on "Confirming…" forever.
     *
     * Rendering inside StrictMode here is the point: without it, the broken
     * version passed.
     */
    verifyEmail.mockResolvedValue({ status: 'verified' });
    renderPage();

    await userEvent.click(confirmButton());

    await waitFor(() => {
      expect(screen.getByText(/your email address is confirmed/i)).toBeInTheDocument();
    });
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith({ token: 'tf_ev_a-real-looking-token' });
  });

  it('offers a retry after a failure', async () => {
    // The button stays, so a failure caused by a dropped connection does not
    // require finding the email again.
    verifyEmail.mockRejectedValueOnce(new Error('network')).mockResolvedValue({
      status: 'verified',
    });
    renderPage();

    await userEvent.click(confirmButton());
    await screen.findByText(/that link did not work/i);

    await userEvent.click(confirmButton());
    await waitFor(() => {
      expect(screen.getByText(/your email address is confirmed/i)).toBeInTheDocument();
    });
  });

  it('explains a link that arrived without a token instead of calling the API', async () => {
    search.token = undefined;
    renderPage();

    expect(await screen.findByText(/missing its token/i)).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});
