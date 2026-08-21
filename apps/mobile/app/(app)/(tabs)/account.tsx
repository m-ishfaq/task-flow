import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../../src/lib/app-session.js';
import { useSession } from '../../../src/lib/use-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import {
  loadPasskeys,
  toRegistrationResponse,
  type PasskeyCreationResult,
} from '../../../src/lib/passkeys.js';

/**
 * The Account tab — the one place `apps/web`'s sidebar footer (`OrgSwitcher`
 * + the account dropdown, `shell.tsx`) puts "which org am I in", "switch
 * it", and "sign out"; nothing here had a home before this navigation-shell
 * increment (see `_layout.tsx`'s own header for why a tab bar exists now at
 * all).
 *
 * **What this deliberately does NOT have yet**, matching web's much larger
 * `account-page.tsx` (656 lines: profile editing, connected accounts, TOTP,
 * device/session inventory, DSAR export) — none of that is built here. This
 * screen is the smallest useful cut: see the current org, leave it, manage
 * a passkey, sign out. A fuller account screen is real, separate work, not
 * something to fold into the navigation-shell fix that motivated this one.
 *
 * "Switch organization" pushes `/org-picker` — the SAME screen
 * `(app)/_layout.tsx`'s gate already redirects to when no valid org is
 * remembered, now also reachable on demand. That screen already handles the
 * "no memberships" case, already calls `session.selectOrg` +
 * `router.replace('/home')` on pick, and already lives outside `(app)/` for
 * the gate-loop reason its own header documents — nothing about it needed
 * to change to be reachable voluntarily as well as by force.
 */
export default function Account() {
  const orgId = useSession((state) => state.orgId);
  const [passkeySupported, setPasskeySupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPasskeys()
      .then((mod) => {
        if (!cancelled) setPasskeySupported(mod.isSupported());
      })
      .catch(() => {
        if (!cancelled) setPasskeySupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
  });
  const currentOrg = orgs.data?.find((org) => org.orgId === orgId);

  const addPasskey = useMutation({
    mutationFn: async () => {
      const options = await apiClient.auth.passkeys.startRegistration.mutate();
      const { create } = await loadPasskeys();
      const result = await create(options as never);
      if (result === null) return null;
      // See sign-in.tsx's identical cast for why.
      const response = toRegistrationResponse(result as unknown as PasskeyCreationResult);
      return apiClient.auth.passkeys.finishRegistration.mutate({ response: response as never });
    },
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Account</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Organization</Text>
        <Text style={styles.orgName}>{currentOrg?.name ?? '—'}</Text>
        {currentOrg !== undefined && <Text style={styles.orgRole}>{currentOrg.role}</Text>}
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            router.push('/org-picker');
          }}
        >
          <Text style={styles.secondaryButtonText}>Switch organization</Text>
        </Pressable>
      </View>

      {passkeySupported && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Security</Text>
          {addPasskey.isError && (
            <Text style={styles.error} accessibilityRole="alert">
              {apiErrorOf(addPasskey.error)?.error.message ?? 'Could not add a passkey.'}
            </Text>
          )}
          {addPasskey.isSuccess && addPasskey.data !== null && (
            <Text style={styles.hint}>Passkey added.</Text>
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
    paddingTop: 24,
    paddingHorizontal: 24,
    gap: 20,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  section: {
    gap: 6,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkFaint.hex,
    textTransform: 'uppercase',
  },
  orgName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  orgRole: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  hint: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  button: {
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger.hex,
    marginTop: 'auto',
    marginBottom: 24,
  },
  buttonText: {
    color: colors.danger.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex,
    marginTop: 4,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
});
