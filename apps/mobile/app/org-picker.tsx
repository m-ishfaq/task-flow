import { Redirect, router } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../src/lib/app-session.js';
import { useSession } from '../src/lib/use-session.js';
import { useTopInset } from '../src/lib/use-top-inset.js';

/**
 * Shown when `(app)/_layout.tsx`'s org gate found no valid remembered
 * selection (ai/phase-14-mobile.md §7). `tenancy.orgs.list` is the same
 * `selfRoute` the gate itself calls — TanStack Query serves it from cache
 * under the identical query key, so picking an org costs nothing extra here.
 *
 * Deliberately a TOP-LEVEL route, not nested under `(app)/` alongside
 * `home.tsx` — mirroring `apps/web/src/router.tsx`'s `/orgs` route, which
 * takes `requireSession` (auth only) rather than `requireOrg`. It was
 * originally nested under `(app)/`, and a real run found the bug that
 * placement causes: `(app)/_layout.tsx`'s gate unconditionally redirects to
 * `/org-picker` whenever `orgId` is null, and a route inside `(app)/` is
 * still wrapped by that same layout — so landing on `/org-picker` re-ran the
 * gate, found `orgId` still null, and redirected to `/org-picker` again,
 * forever ("Maximum update depth exceeded"). Living outside `(app)/` is what
 * lets the redirect actually be an ESCAPE from the gate rather than a route
 * the gate still governs. Auth (not org membership) is still required here,
 * so it carries its own minimal guard below rather than inheriting one.
 */
export default function OrgPicker() {
  const status = useSession((state) => state.status);
  if (status !== 'authenticated') return <Redirect href="/sign-in" />;

  return <OrgPickerContent />;
}

function OrgPickerContent() {
  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
    retry: false,
  });
  const paddingTop = useTopInset();

  if (orgs.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Text style={styles.title}>Choose an organization</Text>
      <FlatList
        data={orgs.data ?? []}
        keyExtractor={(org) => org.orgId}
        ListFooterComponent={
          /* This screen has no tab bar (it lives outside `(app)/` — see this
             file's own header on why) and, until now, no way off it either:
             someone belonging to zero organizations landed on an empty list
             with nothing to press. `signOut` is what `(auth)/_layout.tsx`'s
             own gate reacts to — the same navigation-by-state-change this
             file's own `selectOrg` comment below already argues is not
             automatic, so this is a real escape, not a hope that one exists. */
          <Pressable
            style={styles.signOutButton}
            onPress={() => {
              void session.signOut();
            }}
          >
            <Text style={styles.signOutButtonText}>Sign out</Text>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              // `selectOrg` only updates the store; nothing here is wrapped
              // by a gate that reacts to that change by itself, since this
              // screen now lives OUTSIDE (app)/ (see this file's own header)
              // — and even nested, a re-render swapping `<Redirect>` for
              // `<Slot />` would still show whatever route is ALREADY
              // active, not navigate anywhere. A real run found exactly
              // that: picking an org visibly did nothing. `router.replace`
              // is the actual navigation, mirroring how `(auth)/_layout.tsx`'s
              // own `<Redirect>` is what moves a signed-in caller off
              // `/sign-in` rather than assuming it happens implicitly.
              // The cast matches apps/web's org-picker-page.tsx at the same
              // boundary — see (app)/_layout.tsx's own note on why.
              void (async () => {
                await session.selectOrg(item.orgId as OrgId);
                router.replace('/home');
              })();
            }}
          >
            <Text style={styles.rowTitle}>{item.name}</Text>
            <Text style={styles.rowSubtitle}>{item.role}</Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>You are not a member of any organization yet.</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 0,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 12,
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 16,
    marginBottom: 8,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.inkMuted.hex,
    textTransform: 'capitalize',
  },
  empty: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    marginTop: 24,
    textAlign: 'center',
  },
  signOutButton: {
    borderRadius: radiusCard + 2,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger.hex + '40',
    backgroundColor: colors.danger.hex + '08',
    marginTop: 16,
  },
  signOutButtonText: {
    color: colors.danger.hex,
    fontSize: 15,
    fontWeight: '600',
  },
});
