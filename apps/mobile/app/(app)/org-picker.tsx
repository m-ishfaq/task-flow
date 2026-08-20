import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { apiClient, session } from '../../src/lib/app-session.js';

/**
 * Shown only when `(app)/_layout.tsx`'s org gate found no valid remembered
 * selection (ai/phase-14-mobile.md §7). `tenancy.orgs.list` is the same
 * `selfRoute` the gate itself calls — TanStack Query serves it from cache
 * under the identical query key, so picking an org costs nothing extra here.
 */
export default function OrgPicker() {
  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
    retry: false,
  });

  if (orgs.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
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
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  rowSubtitle: {
    fontSize: 13,
    color: '#666',
    marginTop: 2,
  },
  empty: {
    fontSize: 14,
    color: '#666',
    marginTop: 24,
    textAlign: 'center',
  },
});
