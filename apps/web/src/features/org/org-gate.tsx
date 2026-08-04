import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../lib/session.js';
import { Spinner } from '../../components/primitives.js';
import { orgsQuery } from './api.js';

/**
 * Validates the remembered organization before the router renders anything.
 *
 * ## The bug this exists to close
 *
 * The selected org is persisted in `localStorage` (see `lib/session.ts`) and is
 * read at module load — before a session exists, and therefore before anyone
 * knows WHOSE selection it is. The router's `requireOrg` guard only asks whether
 * an org is selected, so a stored id that names an org the caller is not in
 * passed the guard, reached `/projects`, and every query on the page came back
 * NOT_A_MEMBER. Nothing cleared it except signing out, which is why it appeared
 * exactly once per browser and then "fixed itself" forever.
 *
 * A dropped database, a revoked membership, and a second person signing in at
 * the same machine all produce that state, and the first two are ordinary during
 * development.
 *
 * ## Why it blocks
 *
 * The check must settle BEFORE the first org-scoped request goes out, or the
 * page it is meant to protect has already failed and shown its error card. So
 * this renders a spinner instead of the router while `tenancy.orgs.list` is in
 * flight. That query is a `selfRoute` answered under `withUserScope` — it is the
 * one read that works with no org selected, which is what makes it usable as the
 * arbiter here.
 *
 * It costs nothing extra: the org switcher in the shell issues the same query
 * under the same key, so TanStack serves it from cache the moment the router
 * mounts.
 *
 * ## Why it does not decide anything else
 *
 * "Is this id one of mine" is a membership question, not an authorization one.
 * The gate never inspects a role and never decides what the user may do — §8.2's
 * rule that the UI must not re-derive `can()` is untouched. Every route it
 * admits is still enforced by `route({ permission })` on the server.
 */
export function OrgGate({ children }: { readonly children: ReactNode }) {
  const status = useSession((state) => state.status);
  const orgId = useSession((state) => state.orgId);
  const selectOrg = useSession((state) => state.selectOrg);

  /* Nothing to validate with no session (the login page must not wait on a
     query it cannot make) and nothing to validate with no selection — that
     already routes to the picker. */
  const checking = status === 'authenticated' && orgId !== null;

  /**
   * `retry: false` matters here and nowhere else this query is used.
   *
   * A retried query stays `pending` through its whole backoff sequence, so the
   * default two attempts hold the spinner up for several seconds before the app
   * appears at all — and an API that cannot answer this call cannot answer any
   * of the ones behind it either. Failing fast renders the app, and the pages
   * that need the server report their own failures where the user can retry
   * them.
   */
  const orgs = useQuery({ ...orgsQuery(), enabled: checking, retry: false });

  useEffect(() => {
    if (!checking || orgs.data === undefined) return;
    if (orgs.data.some((org) => org.orgId === orgId)) return;

    /* Not an error state and not a message. The selection was a client-side
       memory of something that is no longer true, so forgetting it is the whole
       repair — `requireOrg` sends them to the picker on the next guard. */
    selectOrg(null);
  }, [checking, orgs.data, orgId, selectOrg]);

  /* `isPending` is also true when the query is disabled, so `checking` has to
     lead — otherwise the login page renders a spinner forever.

     An ERROR does not block. The API being unreachable is not evidence that the
     stored org is wrong, and refusing to render the app over it would turn a
     transient outage into a white screen with no way to retry. The request goes
     out with the org header, the server decides, and `recoverFromLostOrg` in
     lib/query.ts is what catches the answer. */
  if (checking && orgs.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  return <>{children}</>;
}
