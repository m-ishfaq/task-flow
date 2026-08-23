import { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { colors } from '@taskflow/tokens';
import { apiClient, prefs, session } from '../../src/lib/app-session.js';
import { useSession } from '../../src/lib/use-session.js';
import { readRememberedOrg } from '../../src/lib/session.js';
import { resolveRememberedOrg } from '../../src/lib/org-gate.js';
import { CallSurface } from '../../src/lib/call-surface.js';
import { TopBar } from '../../src/lib/top-bar.js';

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
 *
 * ## A real `<Stack>`, not `<Slot />` — found live, from a real navigation bug
 *
 * This rendered a bare `<Slot />` originally, on the reasoning that
 * `(tabs)/_layout.tsx`'s own `<Tabs>` was the only navigator this app
 * needed. A real device run found what that actually does: with NO
 * `<Stack>` anywhere composing `(tabs)`, `card/[cardId]`, `board/[boardId]`,
 * `project/[projectId]` and `channel/[channelId]` into one navigator,
 * `router.push` between them was not creating genuine pushed history at
 * all — `router.back()` from ANY of those screens, regardless of how deep
 * the actual navigation had gone (Boards tab → a project → a board → a
 * card), landed on My Tasks every time, because that is `(tabs)`' own
 * initial route and there was no real stack for `back()` to pop through
 * instead. `<Stack screenOptions={{ headerShown: false }} />` with no
 * explicit `<Stack.Screen>` children auto-registers every route under
 * `(app)/` — `(tabs)` included, as one entry — giving `router.back()` an
 * actual stack to pop: Card → Board → Project → Boards. `headerShown:
 * false` keeps the native header off, since every screen already draws its
 * own "← Back" `Pressable` for visual consistency with the rest of the app;
 * the fix here is the STACK's existence, not its chrome.
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

  return (
    <View style={styles.stackWrapper}>
      <Stack screenOptions={{ headerShown: false }} />
      {/* Mounted once, above every screen under `(app)/` — a ringing call
          has to be answerable from wherever somebody happens to be, and a
          call in progress has to survive navigating away from the
          conversation that started it. `call-surface.tsx`'s own header has
          the full design (ai/phase-13-webrtc.md §7, Wave 5 here). */}
      <CallSurface />
      {/* Same reasoning, same pattern — a mention or DM notification is not
          a Chat-tab concern, and `notification-bell.tsx`'s own header has
          the real-device report that found it was only reachable from
          there. `top-bar.tsx` now also carries the Account icon, moved out
          of the tab bar — see its own header for why. */}
      <TopBar />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
  /* `CallSurface`'s own `position: 'absolute', inset: 0` needs a
     same-sized, non-static ancestor to anchor to — a bare `<Stack />`
     alongside it with no wrapping `View` would leave nothing for that to
     be relative to. */
  stackWrapper: {
    flex: 1,
  },
});
