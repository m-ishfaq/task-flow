import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';

/**
 * The gate that validates a REMEMBERED organization against the caller's actual
 * memberships.
 *
 * Written after this failure: sign up, verify the address, sign in, and the
 * projects page answers "You are not a member of this organization" — once.
 * Signing out and back in fixed it permanently, which is what made it look like
 * a fluke rather than a bug.
 *
 * It was not a fluke. The selected org lives in `localStorage` and is read at
 * module load, so it survives the account that chose it and the database it
 * named. The router guard only asked whether an org was SELECTED, so a stale id
 * passed straight through to a page whose every query then failed — and the only
 * thing in the app that cleared the stored value was the sign-out button.
 *
 * The tests below are about ORDER as much as outcome. A check that runs
 * alongside the first org-scoped query is no check at all: the error card is
 * already on screen by the time it answers.
 */

const listOrgs = vi.fn<() => Promise<{ orgId: string; name: string; role: string }[]>>();

vi.mock('../../lib/trpc.js', () => ({
  api: { tenancy: { orgs: { list: { query: () => listOrgs() } } } },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

const { OrgGate } = await import('./org-gate.js');

const MINE = '019faee8-0000-7000-8000-000000000001';
const THEIRS = '019faee8-0000-7000-8000-000000000002';

function renderGate() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <OrgGate>
        <p>the app</p>
      </OrgGate>
    </QueryClientProvider>,
  );
}

/** Signed in, with `orgId` already remembered from a previous visit. */
function signedInWithStoredOrg(orgId: string) {
  useSession.setState({
    status: 'authenticated',
    accessToken: 'token',
    expiresAt: Date.now() + 600_000,
    sessionId: 'session',
    orgId: orgId as never,
    email: null,
  });
}

beforeEach(() => {
  listOrgs.mockReset();
  useSession.setState({
    status: 'anonymous',
    accessToken: null,
    expiresAt: null,
    sessionId: null,
    orgId: null,
    email: null,
  });
  window.localStorage.clear();
});

describe('validating the remembered organization', () => {
  it('forgets an org the caller is not a member of', async () => {
    /* The reported bug, reproduced: storage names an org that the server does
       not list — a dropped database, a revoked membership, or the previous
       person at this browser. */
    window.localStorage.setItem('taskflow.org', THEIRS);
    signedInWithStoredOrg(THEIRS);
    listOrgs.mockResolvedValue([{ orgId: MINE, name: 'Mine', role: 'owner' }]);

    renderGate();

    await waitFor(() => {
      expect(useSession.getState().orgId).toBeNull();
    });
    /* Forgotten in STORAGE too, not just in memory. Leaving it on disk would
       reinstate the same stale id on the next reload and reopen the bug. */
    expect(window.localStorage.getItem('taskflow.org')).toBeNull();
    expect(await screen.findByText('the app')).toBeInTheDocument();
  });

  it('keeps an org the caller is still a member of', async () => {
    window.localStorage.setItem('taskflow.org', MINE);
    signedInWithStoredOrg(MINE);
    listOrgs.mockResolvedValue([{ orgId: MINE, name: 'Mine', role: 'owner' }]);

    renderGate();

    expect(await screen.findByText('the app')).toBeInTheDocument();
    expect(useSession.getState().orgId).toBe(MINE);
  });

  it('renders nothing until the answer arrives', () => {
    /**
     * The property that makes this a fix rather than a second opinion.
     *
     * If the app renders while the check is in flight, `/projects` mounts, fires
     * `projects.list` with the stale header, and shows its error. Clearing the
     * org a moment later does not take that back — the user has already seen the
     * failure this gate exists to prevent.
     */
    window.localStorage.setItem('taskflow.org', THEIRS);
    signedInWithStoredOrg(THEIRS);
    // Never settles: the assertion is about what is on screen WHILE the check
    // is outstanding, so the check must stay outstanding.
    listOrgs.mockReturnValue(
      new Promise(() => {
        /* deliberately never resolved */
      }),
    );

    renderGate();

    expect(screen.queryByText('the app')).not.toBeInTheDocument();
  });

  it('does not query, or block, when nobody is signed in', () => {
    // The login page must not wait on a call it has no credential for.
    renderGate();

    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('does not query when no org is remembered', () => {
    // Nothing to validate, and `requireOrg` already routes this case.
    useSession.setState({ status: 'authenticated', orgId: null });

    renderGate();

    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('renders the app anyway when the check itself fails', async () => {
    /* An unreachable API is not evidence that the stored org is wrong, and
       blocking on it would turn an outage into a permanent spinner with no
       retry. The selection is left alone and the server gets to decide. */
    window.localStorage.setItem('taskflow.org', MINE);
    signedInWithStoredOrg(MINE);
    listOrgs.mockRejectedValue(new Error('offline'));

    renderGate();

    expect(await screen.findByText('the app')).toBeInTheDocument();
    expect(useSession.getState().orgId).toBe(MINE);
  });
});
