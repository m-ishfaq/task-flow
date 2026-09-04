import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './trpc.js';
import { keys, useOrgKey } from './query.js';

/**
 * The caller's resolved feature-flag snapshot (`platformAdmin`'s sibling,
 * `flags.snapshot` — `apps/api/src/router.ts`) — every registered flag,
 * resolved through plan -> override -> environment -> registry default for
 * whichever org is currently selected.
 *
 * Nothing called this route from `apps/web` before now. It exists
 * specifically for this: letting the UI show a locked state for a module the
 * org's plan does not include, INSTEAD of a dead link that fails only once
 * clicked. It is explicitly not the enforcement point — the route's own
 * comment says so — every gated server route re-resolves entitlements on
 * its own via `route({ feature })`. A stale or wrong answer here costs a
 * wrong-looking nav item, never real access; the worst this hook can do is
 * cosmetic.
 */
export function useEntitlements(): UseQueryResult<Readonly<Record<string, boolean>>> {
  const orgId = useOrgKey();
  return useQuery({
    queryKey: keys.flags(orgId),
    queryFn: async () => api.flags.snapshot.query(),
  });
}

/**
 * Whether one flag is granted, or `undefined` while the snapshot is still
 * loading — callers that need to distinguish "not yet known" from "known
 * false" (to avoid a locked-flash before the real answer arrives) read this
 * directly rather than defaulting to `false`.
 */
export function useFeatureGranted(flag: string): boolean | undefined {
  const { data } = useEntitlements();
  return data?.[flag];
}
