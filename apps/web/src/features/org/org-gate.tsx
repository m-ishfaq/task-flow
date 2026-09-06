import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { Button, Empty, Spinner } from '../../components/primitives.js';
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
 * ## A row that IS there, just not active, is a DIFFERENT case from no row at all
 *
 * `tenancy.orgs.list` returns every membership, active or suspended (see that
 * function's own header) — it used to filter to `'active'` only, which made a
 * suspended membership indistinguishable from a stale selection naming an org
 * the caller was never in: both simply vanished from the list, and this gate
 * treated both the same way, silently clearing the selection and letting
 * `requireOrg` bounce to the picker with nothing on screen explaining why. A
 * real report: a member whose row the platform console itself showed as
 * `status: suspended` got exactly that silent bounce and had no way to tell
 * "your access here ended" apart from "you typed the wrong URL."
 *
 * The fix is the same split `resolveOrgMembership` makes server-side: a row
 * that matches `orgId` but whose `membershipStatus` is not `'active'` renders
 * a direct explanation INSTEAD of the router, with a button back to the
 * picker — never silently dropped and redirected. Only a genuinely MISSING
 * row (no such org, or truly never a member) keeps the old silent-drop
 * behavior, because there — unlike a suspension — there is nothing true and
 * useful to say beyond "that selection no longer means anything," which
 * `requireOrg`'s own redirect to the picker already communicates by simply
 * not finding the org there.
 *
 * ## Why it does not decide anything else
 *
 * "Is this id one of mine, and is it active" is a membership question, not an
 * authorization one. The gate never inspects a role and never decides what the
 * user may do — §8.2's rule that the UI must not re-derive `can()` is untouched.
 * Every route it admits is still enforced by `route({ permission })` on the
 * server.
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

  /* The row matching the stored selection, whatever its status — `undefined`
     covers both "not checking yet" and "no such row at all". Kept as ONE
     value, rather than a separate `selected` lookup plus a `suspended`
     boolean derived from it, so the render below never has to re-assert a
     fact this already settled (which is what a second `!== undefined` check
     on the same expression would be). */
  const matched =
    checking && orgs.data !== undefined ? orgs.data.find((org) => org.orgId === orgId) : undefined;

  useEffect(() => {
    if (!checking || orgs.data === undefined) return;
    // A row that exists but is not active is handled by rendering an
    // explanation below, never by silently dropping the selection — see this
    // file's own header. Only a genuinely MISSING row falls through to the
    // silent-drop repair.
    if (matched !== undefined) return;

    /* Not an error state and not a message. The selection was a client-side
       memory of something that is no longer true, so forgetting it is the whole
       repair — `requireOrg` sends them to the picker on the next guard. */
    selectOrg(null);
  }, [checking, orgs.data, orgId, selectOrg, matched]);

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

  if (matched !== undefined && matched.membershipStatus !== 'active') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty
          icon={<Ban aria-hidden="true" className="size-5" />}
          title="Your access to this organization was suspended"
          description={`Your membership in "${matched.name}" is no longer active. Choose a different organization, or ask an admin there to reactivate your access.`}
          action={
            <Button
              variant="primary"
              onClick={() => {
                /* No navigation call needed: dropping the selection is
                   exactly what `requireOrg`'s own guard already reads as
                   "route to the picker" the moment the router underneath
                   this gate gets to render — the identical mechanism the
                   no-selection case has always used. */
                selectOrg(null);
              }}
            >
              Choose a different organization
            </Button>
          }
        />
      </div>
    );
  }

  return <>{children}</>;
}
