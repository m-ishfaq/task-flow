import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { EXPO_PUSH_TOKENS_QUERY_KEY, registerForPushNotifications } from './push-notifications.js';

/**
 * Native push, on the account screen — `apps/web`'s push half of
 * `NotificationPreferencesSection`, ported (the category/channel
 * preference MATRIX that section also renders is a separate, real gap: no
 * screen on native reads `notifications.prefs.*` at all yet, and this
 * increment is scoped to the ceremony that gets a device REGISTERED in the
 * first place — `direct.push` already defaults to enabled server-side, so
 * registering here starts real delivery with no preference edit needed).
 *
 * **"Enable on this device" is the whole ceremony in one button** —
 * `registerForPushNotifications` (`push-notifications.ts`) never throws,
 * so this needs one branch, not a try/catch around a promise that
 * sometimes rejects. Mirrors web's own rule for the identical reason: a
 * button that succeeds silently but delivers nothing is worse than one
 * that says why it failed (permission denied, no EAS project configured,
 * no token returned).
 */
export function PushNotificationsSection() {
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const devices = useQuery({
    queryKey: EXPO_PUSH_TOKENS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.notifications.expoPush.list.query()),
  });

  const enable = async (): Promise<void> => {
    setRegistering(true);
    setRegisterError(null);
    const result = await registerForPushNotifications();
    setRegistering(false);
    if (result.ok) {
      await queryClient.invalidateQueries({ queryKey: EXPO_PUSH_TOKENS_QUERY_KEY });
    } else {
      setRegisterError(result.reason);
    }
  };

  const removeDevice = useMutation({
    mutationFn: (tokenId: string) =>
      apiClient.notifications.expoPush.unregister.mutate({ tokenId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: EXPO_PUSH_TOKENS_QUERY_KEY });
    },
  });

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Push notifications</Text>
      <Text style={styles.sectionHint}>
        Get notified on this device for mentions, direct messages, and assignments.
      </Text>

      <Pressable
        style={styles.enableButton}
        disabled={registering}
        onPress={() => {
          void enable();
        }}
      >
        {registering ? (
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.enableButtonText}>Enable on this device</Text>
        )}
      </Pressable>
      {registerError !== null && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {registerError}
        </Text>
      )}

      {devices.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : devices.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(devices.error)?.error.message ?? "Couldn't load your registered devices."}
        </Text>
      ) : (
        devices.data.length > 0 && (
          <View style={styles.deviceList}>
            {devices.data.map((device) => (
              <View key={device.tokenId} style={styles.deviceRow}>
                <Text style={styles.deviceLabel} numberOfLines={1}>
                  {device.deviceLabel ?? 'Unknown device'}
                </Text>
                <Pressable
                  disabled={removeDevice.isPending}
                  onPress={() => {
                    removeDevice.mutate(device.tokenId);
                  }}
                >
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )
      )}
      {removeDevice.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(removeDevice.error)?.error.message ?? 'That device could not be removed.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  enableButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  enableButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  deviceList: {
    gap: 2,
    marginTop: 4,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 6,
  },
  deviceLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.ink.hex,
  },
  removeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
