import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { apiClient, session } from '../../src/lib/app-session.js';
import { useSession } from '../../src/lib/use-session.js';

/**
 * Wave 1's entire signed-in product surface (ai/phase-14-mobile.md §7): a
 * placeholder that proves the spine, nothing more. Reaching this screen at
 * all means the auth gate and the org gate both passed; `auth.me` below is
 * the "one authenticated tRPC read" the phase's Wave 1 acceptance bar names.
 * Real product screens start in Wave 2.
 */
export default function Home() {
  const orgId = useSession((state) => state.orgId);

  const me = useQuery({
    queryKey: ['auth.me'],
    queryFn: () => apiClient.auth.me.query(),
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>You&apos;re signed in</Text>

      {me.isPending && <ActivityIndicator />}
      {me.data !== undefined && (
        <View style={styles.card}>
          <Text style={styles.label}>Signed in as</Text>
          <Text style={styles.value}>{me.data.email}</Text>
          <Text style={styles.label}>Organization</Text>
          <Text style={styles.value}>{orgId}</Text>
        </View>
      )}

      <Pressable
        style={styles.button}
        onPress={() => {
          void session.signOut();
        }}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
  },
  card: {
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: '#666',
    marginTop: 8,
  },
  value: {
    fontSize: 16,
  },
  button: {
    marginTop: 'auto',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#c00',
  },
  buttonText: {
    color: '#c00',
    fontSize: 16,
    fontWeight: '600',
  },
});
