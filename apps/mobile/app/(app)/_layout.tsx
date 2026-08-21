import { useEffect } from 'react';
import { Redirect, Slot } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { colors } from '@taskflow/tokens';
import { apiClient, prefs, session } from '../../src/lib/app-session.js';
import { useSession } from '../../src/lib/use-session.js';
import { readRememberedOrg } from '../../src/lib/session.js';
import { resolveRememberedOrg } from '../../src/lib/org-gate.js';

/**
 * The org gate (ai/phase-14-mobile.md §7), ported from apps/web's `OrgGate` +
 * its router's `requireOrg`. expo-router has no `beforeLoad`, so both halves
 * of that web split collapse into one layout component that decides what to
 * render: unauthenticated -> `/sign-in`; authenticated with no VALID org ->
 * `/org-picker`; authenticated with one -> the guarded screens.
 *
 * All three `useQuery`/`useSession` hooks below run on every render
 * regardless of `status`, deliberately — conditionally skipping them ahead of
 * an early return would violate the rules of hooks. `enabled` is what actually
 * turns them off for an unauthenticated caller, not a branch above them.
 *
 * ## Why two queries instead of one
 *
 * `tenancy.orgs.list` is the arbiter of which ids are real (org-gate.ts's own
 * argument for why nothing renders before it answers). What id to VALIDATE
 * against that list is a separate question: on native, the remembered id was
 * persisted to `AsyncStorage` on a previous run — unlike the web, where
 * `localStorage` is readable synchronously at store creation, `AsyncStorage`
 * is async, so `session.ts`'s store necessarily starts with `orgId: null` and
 * this layout is what hydrates it. `remembered` is disabled the instant
 * `orgId` stops being null (a selection made this run, or the effect below
 * resolving one), so it only ever does its one read.
 *
 * `org-picker.tsx` lives at the app ROOT (`app/org-picker.tsx`), not nested
 * under `(app)/` alongside `home.tsx` — matching `apps/web/src/router.tsx`'s
 * `/orgs` route, which takes `requireSession` rather than `requireOrg`. A
 * real run found the bug the nested placement caused: this layout wraps
 * every route inside `(app)/`, so a nested `org-picker.tsx` was STILL
 * governed by the `orgId === null` redirect below even while already ON
 * `/org-picker` — the gate kept re-firing the same redirect on every render,
 * "Maximum update depth exceeded". The redirect below only works as an
 * ESCAPE from this gate if its target lives outside it.
 */
export default function AppLayout() {
  const status = useSession((state) => state.status);
  const orgId = useSession((state) => state.orgId);

  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
    enabled: status === 'authenticated',
    retry: false,
  });

  const remembered = useQuery({
    queryKey: ['taskflow.rememberedOrg'],
    queryFn: () => readRememberedOrg(prefs),
    enabled: status === 'authenticated' && orgId === null,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (orgId !== null || orgs.data === undefined || remembered.data === undefined) return;
    const resolved = resolveRememberedOrg(
      remembered.data,
      // The wire type is a bare `z.string()` (apps/api/src/tenancy/router.ts's
      // `orgs.list` output) — branded the same way apps/web's own org picker
      // does at this exact boundary (`org.orgId as OrgId` in
      // org-picker-page.tsx): the value already came from our own,
      // RLS-scoped API response, so re-validating it would be pure cost.
      orgs.data.map((org) => ({ id: org.orgId as OrgId })),
    );
    // Nothing to persist when the remembered id was already stale or absent —
    // `selectOrg(null)` would just rewrite the same "nothing selected" state
    // AsyncStorage already holds. `orgId === null` below is what then routes
    // to the picker.
    if (resolved !== null) void session.selectOrg(resolved);
  }, [orgId, orgs.data, remembered.data]);

  if (status !== 'authenticated') return <Redirect href="/sign-in" />;

  const settling = orgId === null && (orgs.isPending || remembered.isPending);
  if (settling) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  if (orgId === null) return <Redirect href="/org-picker" />;

  return <Slot />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
});
