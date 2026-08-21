import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { create, isSupported as isPasskeySupported } from 'react-native-passkeys';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { toRegistrationResponse, type PasskeyCreationResult } from '../../src/lib/passkeys.js';
import { useSession } from '../../src/lib/use-session.js';

/**
 * Wave 1's entire signed-in product surface (ai/phase-14-mobile.md §7): a
 * placeholder that proves the spine, nothing more. Reaching this screen at
 * all means the auth gate and the org gate both passed; `auth.me` below is
 * the "one authenticated tRPC read" the phase's Wave 1 acceptance bar names.
 * Real product screens start in Wave 2.
 *
 * The "Add a passkey" action lives here rather than on a proper settings
 * screen for the same reason `home.tsx` itself is a placeholder: Wave 2
 * builds the real one. It has to live SOMEWHERE reachable, though — neither
 * web nor mobile has shipped passkey ENROLLMENT before this increment (only
 * the server ceremony existed), so without it there would be no way for any
 * user to ever have a passkey to sign in with on `(auth)/sign-in.tsx`'s new
 * button.
 */
export default function Home() {
  const orgId = useSession((state) => state.orgId);

  const me = useQuery({
    queryKey: ['auth.me'],
    queryFn: () => apiClient.auth.me.query(),
  });

  const addPasskey = useMutation({
    mutationFn: async () => {
      const options = await apiClient.auth.passkeys.startRegistration.mutate();
      const result = await create(options as never);
      if (result === null) return null;
      // See sign-in.tsx's identical cast for why: the library's own
      // CreationResponse type and this function's precise, hand-written
      // PasskeyCreationResult describe the same wire shape under two
      // different TypeScript declarations.
      const response = toRegistrationResponse(result as unknown as PasskeyCreationResult);
      return apiClient.auth.passkeys.finishRegistration.mutate({ response: response as never });
    },
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>You&apos;re signed in</Text>

      {me.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {me.data !== undefined && (
        <View style={styles.card}>
          <Text style={styles.label}>Signed in as</Text>
          <Text style={styles.value}>{me.data.email}</Text>
          <Text style={styles.label}>Organization</Text>
          <Text style={styles.value}>{orgId}</Text>
        </View>
      )}

      {isPasskeySupported() && (
        <>
          {addPasskey.isError && (
            <Text style={styles.error} accessibilityRole="alert">
              {apiErrorOf(addPasskey.error)?.error.message ?? 'Could not add a passkey.'}
            </Text>
          )}
          {addPasskey.isSuccess && addPasskey.data !== null && (
            <Text style={styles.label}>Passkey added.</Text>
          )}
          <Pressable
            style={styles.secondaryButton}
            disabled={addPasskey.isPending}
            onPress={() => {
              addPasskey.mutate();
            }}
          >
            {addPasskey.isPending ? (
              <ActivityIndicator color={colors.ink.hex} />
            ) : (
              <Text style={styles.secondaryButtonText}>Add a passkey to this device</Text>
            )}
          </Pressable>
        </>
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
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  card: {
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: 8,
  },
  value: {
    fontSize: 16,
    color: colors.ink.hex,
  },
  button: {
    marginTop: 'auto',
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger.hex,
  },
  buttonText: {
    color: colors.danger.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
});
