import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createQueryClient, dropOrgScopedQueries, onOrgLost } from './lib/query.js';
import { restore, useSession } from './lib/session.js';
import { createAppRouter } from './router.js';
import { OrgGate } from './features/org/org-gate.js';
import { ToastProvider } from './components/toast.js';
import { Spinner } from './components/primitives.js';

/**
 * Providers, and the one thing that has to happen before anything renders.
 *
 * `restore()` exchanges the httpOnly refresh cookie for an access token. It is
 * unavoidable on every load, because the access token is held in memory and
 * never in storage — see the header comment in lib/session.ts for why that
 * trade is made deliberately.
 *
 * Until it settles the status is `restoring`, and the app renders a spinner
 * rather than the login page. Rendering login first would flash the sign-in form
 * at every already-signed-in user on every navigation to the app, and worse,
 * a router redirect fired during that window would throw away the URL they
 * actually asked for.
 */

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

/**
 * Where a NOT_A_MEMBER lands.
 *
 * `lib/query.ts` has already dropped the selected org by the time this runs —
 * it is the only module that sees every failure — but dropping it does not move
 * anyone: TanStack Router does not re-run `beforeLoad` because a store changed,
 * so without this the user sits on `/projects` looking at an error for an org
 * the app no longer thinks it has.
 *
 * The cache is emptied AFTER the navigation resolves, not before. Removing a
 * query that a mounted component is still observing makes it refetch, and the
 * refetch would go out with no org header and fail exactly the same way. Once
 * the picker is on screen those components are gone.
 */
onOrgLost(() => {
  void (async () => {
    await router.navigate({ to: '/orgs' });
    dropOrgScopedQueries(queryClient);
  })();
});

export function App() {
  const status = useSession((state) => state.status);
  const [restoreFailed, setRestoreFailed] = useState(false);

  useEffect(() => {
    restore().catch(() => {
      /* `restore` already settles the session to `anonymous` on an
         authentication failure. Reaching here means something else went wrong —
         the API being unreachable, most likely — and the app must still stop
         showing a spinner. */
      setRestoreFailed(true);
    });
  }, []);

  if (status === 'restoring' && !restoreFailed) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* Outside `OrgGate` so a toast survives the gate's spinner, and outside
          the router so a mutation's rollback message is not unmounted by the
          navigation that failure may have caused. */}
      <ToastProvider>
        {/* Inside the query provider because it asks a query, and outside the
            router because its whole job is to settle before a route can issue
            one. */}
        <OrgGate>
          <RouterProvider router={router} />
        </OrgGate>
      </ToastProvider>
    </QueryClientProvider>
  );
}
