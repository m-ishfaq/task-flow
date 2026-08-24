import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { EXPO_PUSH_TOKENS_QUERY_KEY } from './push-notifications.js';
import { NOTIFICATION_PREFS_QUERY_KEY, type NotificationPrefEntry } from './notifications.js';

/**
 * The category × channel preference matrix, ported from
 * `apps/web/src/features/notifications/notification-prefs-section.tsx` —
 * the gap `push-notifications-section.tsx`'s own header named and left open
 * ("no screen on native reads `notifications.prefs.*` at all yet"), closed
 * here as its own increment rather than folded into that file, since the
 * two are genuinely different concerns: that section is the device-
 * REGISTRATION ceremony, this is which categories reach you on which
 * channel once a device (or email, which needs no ceremony at all) exists.
 *
 * ## Toggle chips, not checkboxes
 *
 * Web renders an `<input type="checkbox">` per cell — this app has no
 * cheap native equivalent at a comfortable touch-target size, so each cell
 * is the same accent-when-active chip `search-button.tsx`'s facet row and
 * `docs-space/[spaceId].tsx`'s template picker already use, tapped to
 * toggle rather than checked.
 *
 * ## Push has a real, honest disabled reason; SMS does not exist yet
 *
 * Web's push column can be disabled for three different reasons (no VAPID
 * key, unsupported browser, blocked permission) because ENABLING it there
 * runs a whole ceremony inline. On mobile the ceremony is a separate button
 * (`push-notifications-section.tsx`'s "Enable on this device") — so this
 * matrix only needs to know whether the ceremony has ever succeeded for
 * this account, via the same `expoPush.list` query that section already
 * reads. Zero devices registered means toggling this preference on would
 * save a setting nothing could ever act on — the same silent lie web's own
 * header names — so the push column is disabled with a reason pointing at
 * the section below, rather than a checkbox that flips and delivers
 * nothing. SMS keeps web's own "Coming soon…" — no provider exists to
 * carry it on either platform.
 */

interface CategoryOption {
  readonly value: NotificationPrefEntry['category'];
  readonly label: string;
  readonly description: string;
}

const CATEGORIES: readonly CategoryOption[] = [
  {
    value: 'direct',
    label: 'Mentions, DMs & assignments',
    description: 'Someone @mentioned you, sent you a direct message, or assigned you a card.',
  },
  {
    value: 'activity',
    label: 'Replies, comments & due dates',
    description: 'Replies to your own messages, other comments, and cards coming due.',
  },
];

interface ChannelOption {
  readonly value: NotificationPrefEntry['channel'];
  readonly label: string;
  readonly disabledReason?: string;
}

export function NotificationPreferencesSection() {
  const queryClient = useQueryClient();

  const prefs = useQuery({
    queryKey: NOTIFICATION_PREFS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.notifications.prefs.list.query()),
  });

  const devices = useQuery({
    queryKey: EXPO_PUSH_TOKENS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.notifications.expoPush.list.query()),
  });

  const setPref = useMutation({
    mutationFn: (input: {
      readonly category: NotificationPrefEntry['category'];
      readonly channel: NotificationPrefEntry['channel'];
      readonly enabled: boolean;
    }) => apiClient.notifications.prefs.set.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: NOTIFICATION_PREFS_QUERY_KEY });
    },
  });

  if (prefs.isPending) {
    return (
      <View style={styles.section}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }
  if (prefs.isError) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(prefs.error)?.error.message ?? 'Could not load notification preferences.'}
        </Text>
      </View>
    );
  }

  const registeredDevices = devices.data?.length ?? 0;
  const pushDisabledReason =
    registeredDevices === 0
      ? "No device registered yet — see 'Push notifications' below."
      : undefined;

  const channels: readonly ChannelOption[] = [
    { value: 'email', label: 'Email' },
    {
      value: 'push',
      label: 'Push',
      ...(pushDisabledReason !== undefined && { disabledReason: pushDisabledReason }),
    },
    { value: 'sms', label: 'SMS', disabledReason: 'Coming soon…' },
  ];

  const enabledFor = (category: string, channel: string): boolean =>
    prefs.data.find((entry) => entry.category === category && entry.channel === channel)?.enabled ??
    false;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Notifications</Text>
      <Text style={styles.sectionHint}>
        How you're told about mentions, assignments, and activity, wherever you sign in.
      </Text>

      <View style={styles.categoryList}>
        {CATEGORIES.map((category) => {
          const disabledNotes = channels.filter(
            (channel): channel is ChannelOption & { readonly disabledReason: string } =>
              channel.disabledReason !== undefined,
          );
          return (
            <View key={category.value} style={styles.categoryRow}>
              <Text style={styles.categoryLabel}>{category.label}</Text>
              <Text style={styles.categoryDescription}>{category.description}</Text>
              <View style={styles.chipRow}>
                {channels.map((channel) => {
                  const active = enabledFor(category.value, channel.value);
                  const disabled = channel.disabledReason !== undefined || setPref.isPending;
                  return (
                    <Pressable
                      key={channel.value}
                      style={[
                        styles.chip,
                        active && styles.chipActive,
                        disabled && styles.chipDisabled,
                      ]}
                      disabled={disabled}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: active, disabled }}
                      onPress={() => {
                        setPref.mutate({
                          category: category.value,
                          channel: channel.value,
                          enabled: !active,
                        });
                      }}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {channel.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {disabledNotes.length > 0 && (
                <Text style={styles.disabledNote}>
                  {disabledNotes
                    .map((channel) => `${channel.label}: ${channel.disabledReason}`)
                    .join('  ·  ')}
                </Text>
              )}
            </View>
          );
        })}
      </View>

      {setPref.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(setPref.error)?.error.message ?? 'That preference could not be saved.'}
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
  categoryList: {
    gap: 14,
    marginTop: 4,
  },
  categoryRow: {
    gap: 6,
  },
  categoryLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  categoryDescription: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    backgroundColor: colors.surfaceSunken.hex,
  },
  chipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  chipTextActive: {
    color: colors.accentInk.hex,
  },
  disabledNote: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
});
