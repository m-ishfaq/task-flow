import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const listOrgs = vi.fn<
  () => Promise<
    {
      orgId: string;
      name: string;
      role: string;
      membershipStatus: string;
      orgStatus: string;
    }[]
  >
>();

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
    listOrgs.mockResolvedValue([
      { orgId: MINE, name: 'Mine', role: 'owner', membershipStatus: 'active', orgStatus: 'active' },
    ]);

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
    listOrgs.mockResolvedValue([
      { orgId: MINE, name: 'Mine', role: 'owner', membershipStatus: 'active', orgStatus: 'active' },
    ]);

    renderGate();

    expect(await screen.findByText('the app')).toBeInTheDocument();
    expect(useSession.getState().orgId).toBe(MINE);
  });

  it('explains directly, and does not silently drop the selection, when the membership is suspended', async () => {
    /* The report this pass fixes: `orgs.list` now reports every membership,
       active or suspended, rather than omitting a suspended one the same way
       it omits a row that never existed — this asserts the gate tells the
       two apart rather than treating "found but suspended" as "not found". */
    window.localStorage.setItem('taskflow.org', MINE);
    signedInWithStoredOrg(MINE);
    listOrgs.mockResolvedValue([
      {
        orgId: MINE,
        name: 'Mine',
        role: 'member',
        membershipStatus: 'suspended',
        orgStatus: 'active',
      },
    ]);

    renderGate();

    expect(
      await screen.findByText('Your access to this organization was suspended'),
    ).toBeInTheDocument();
    expect(screen.getByText(/"Mine"/)).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    // Not silently dropped WHILE explaining — the selection is still there
    // for `matched` to keep resolving to the suspended row on a re-render.
    expect(useSession.getState().orgId).toBe(MINE);

    await userEvent.click(screen.getByRole('button', { name: 'Choose a different organization' }));

    // Only NOW, on the explicit click, does the selection actually clear —
    // `requireOrg`'s own guard is what routes to the picker from there.
    expect(useSession.getState().orgId).toBeNull();
  });

  it('explains directly, and prefers the bigger fact, when the ORG itself is suspended', async () => {
    /* The identical gap one level up, closed the same way: `orgStatus` used
       to be absent from `orgs.list` entirely, so a suspended org (Phase 12
       Wave 1's platform console) read as perfectly normal here and only
       failed confusingly on the NEXT screen's first org-scoped query. Both
       flags true at once asserts the "bigger fact wins" rule directly —
       an org-level explanation, not the membership one. */
    window.localStorage.setItem('taskflow.org', MINE);
    signedInWithStoredOrg(MINE);
    listOrgs.mockResolvedValue([
      {
        orgId: MINE,
        name: 'Mine',
        role: 'owner',
        membershipStatus: 'active',
        orgStatus: 'suspended',
      },
    ]);

    renderGate();

    expect(await screen.findByText('This organization has been suspended')).toBeInTheDocument();
    expect(screen.getByText(/"Mine"/)).toBeInTheDocument();
    expect(
      screen.queryByText('Your access to this organization was suspended'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(useSession.getState().orgId).toBe(MINE);

    await userEvent.click(screen.getByRole('button', { name: 'Choose a different organization' }));

    expect(useSession.getState().orgId).toBeNull();
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
