import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Recovery from a selected organization the server does not recognize.
 *
 * NOT_A_MEMBER is a TERMINAL code — retrying it changes nothing, and that
 * classification is correct. What was missing is what happens next: the code
 * arrived, every query on the page failed, and the app stayed exactly where it
 * was with an error card and no route out but signing out.
 *
 * The two properties worth holding onto are both about a BATCH. A board opens a
 * dozen queries at once, so the handler has to be idempotent across the twelve
 * identical failures that follow — otherwise it navigates twelve times and
 * empties the cache under each one.
 */

vi.mock('./trpc.js', () => ({
  /* The real one parses a TRPCClientError envelope. Here the error IS the
     envelope, so a test can produce any code without constructing a transport
     failure to carry it. */
  errorCodeOf: (error: unknown) => (error as { code?: string } | null)?.code ?? null,
  isUnauthenticated: () => false,
  apiErrorOf: () => null,
}));

const { createQueryClient, dropOrgScopedQueries, keys, onOrgLost } = await import('./query.js');
const { useSession } = await import('./session.js');

const ORG = '019faee8-0000-7000-8000-000000000001';

/** A rejection the mocked `errorCodeOf` can read a domain code off. */
class ApiFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiFailure';
  }
}

function notAMember() {
  return Promise.reject(new ApiFailure('NOT_A_MEMBER'));
}

beforeEach(() => {
  useSession.setState({ orgId: ORG as never });
  window.localStorage.setItem('taskflow.org', ORG);
});

describe('a query that fails with NOT_A_MEMBER', () => {
  it('drops the selected org and hands off to the router', async () => {
    const recover = vi.fn();
    onOrgLost(recover);
    const client = createQueryClient();

    await expect(
      client.fetchQuery({ queryKey: keys.projects(ORG), queryFn: notAMember }),
    ).rejects.toBeDefined();

    expect(useSession.getState().orgId).toBeNull();
    expect(window.localStorage.getItem('taskflow.org')).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('acts once for a page full of simultaneous failures', async () => {
    const recover = vi.fn();
    onOrgLost(recover);
    const client = createQueryClient();

    await Promise.allSettled([
      client.fetchQuery({ queryKey: keys.projects(ORG), queryFn: notAMember }),
      client.fetchQuery({ queryKey: keys.members(ORG), queryFn: notAMember }),
      client.fetchQuery({ queryKey: keys.lists(ORG, 'b'), queryFn: notAMember }),
    ]);

    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('leaves other failures alone', async () => {
    const recover = vi.fn();
    onOrgLost(recover);
    const client = createQueryClient();

    await expect(
      client.fetchQuery({
        queryKey: keys.projects(ORG),
        /* FORBIDDEN is the answer for a member who lacks a permission. Dropping
           their org over it would eject them from the app for opening a page
           they simply cannot see. */
        queryFn: () => Promise.reject(new ApiFailure('FORBIDDEN')),
      }),
    ).rejects.toBeDefined();

    expect(useSession.getState().orgId).toBe(ORG);
    expect(recover).not.toHaveBeenCalled();
  });
});

describe('dropOrgScopedQueries', () => {
  it('evicts tenant data and keeps the cross-org membership list', () => {
    const client = createQueryClient();
    client.setQueryData(keys.orgs(), [{ orgId: ORG }]);
    client.setQueryData(keys.projects(ORG), []);
    client.setQueryData(keys.card(ORG, 'c'), {});

    dropOrgScopedQueries(client);

    /* `keys.orgs()` is `['orgs']` and the prefix removed is `['org']`. They are
       different segments, and the picker we navigate to needs the survivor —
       clearing it would make the org switcher and the picker each refetch the
       one query that still works. */
    expect(client.getQueryData(keys.orgs())).toBeDefined();
    expect(client.getQueryData(keys.projects(ORG))).toBeUndefined();
    expect(client.getQueryData(keys.card(ORG, 'c'))).toBeUndefined();
  });
});
