import { Redirect } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { colors } from '@taskflow/tokens';
import { apiClient, session } from '../src/lib/app-session.js';
import { useSession } from '../src/lib/use-session.js';

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

  if (orgs.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Choose an organization</Text>
      <FlatList
        data={orgs.data ?? []}
        keyExtractor={(org) => org.orgId}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              // The (app) layout re-renders on the store update and drops
              // straight into <Slot /> — no imperative navigation needed.
              // The cast matches apps/web's org-picker-page.tsx at the same
              // boundary — see (app)/_layout.tsx's own note on why.
              void session.selectOrg(item.orgId as OrgId);
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
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
    color: colors.ink.hex,
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.ink.hex,
  },
  rowSubtitle: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    marginTop: 2,
  },
  empty: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    marginTop: 24,
    textAlign: 'center',
  },
});
