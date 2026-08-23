import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { CALL_PREFS_QUERY_KEY } from './rtc.js';
import { previewRingtone } from './ringtone-player.js';
import { RINGTONES, RINGTONE_NAMES, type RingtoneName } from './ringtone.js';

/**
 * Ringing preferences, on the account screen — `apps/web`'s
 * `ringtone-section.tsx`, ported. Global per user, not per org, the same
 * `selfRoute` shape `notification_prefs` already has — `rtc.prefs.get`/
 * `.set` resolve no org (ai/phase-13-webrtc.md §7).
 *
 * Tapping a tone PREVIEWS it (`previewRingtone`, one cadence and stop) —
 * choosing one and hearing nothing until the next real call would be a
 * settings row nobody could actually evaluate.
 */
export function RingtoneSection() {
  const queryClient = useQueryClient();

  const prefs = useQuery({
    queryKey: CALL_PREFS_QUERY_KEY,
    queryFn: () => apiClient.rtc.prefs.get.query({}),
  });

  const save = useMutation({
    mutationFn: (input: { ringtone: RingtoneName; ringEnabled: boolean }) =>
      apiClient.rtc.prefs.set.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CALL_PREFS_QUERY_KEY });
    },
  });

  const ringtone = prefs.data?.ringtone ?? 'classic';
  const ringEnabled = prefs.data?.ringEnabled ?? true;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Ringing</Text>
      <Text style={styles.sectionHint}>
        The tone this device plays for an incoming voice call. Tap a tone to hear it.
      </Text>

      <View style={styles.chipRow}>
        {RINGTONE_NAMES.map((name) => (
          <Pressable
            key={name}
            style={[styles.chip, ringtone === name && styles.chipActive]}
            onPress={() => {
              void previewRingtone(name);
              if (ringtone !== name) save.mutate({ ringtone: name, ringEnabled });
            }}
          >
            <Text style={[styles.chipText, ringtone === name && styles.chipTextActive]}>
              {RINGTONES[name].label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={styles.toggleRow}
        onPress={() => {
          save.mutate({ ringtone, ringEnabled: !ringEnabled });
        }}
      >
        <Text style={styles.toggleLabel}>Play a sound when someone calls</Text>
        <View style={[styles.toggleTrack, ringEnabled && styles.toggleTrackOn]}>
          <View style={[styles.toggleThumb, ringEnabled && styles.toggleThumbOn]} />
        </View>
      </Pressable>

      {save.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(save.error)?.error.message ?? 'That preference was not saved.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line.hex + "80",
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: colors.surfaceRaised.hex,
  },
  chipActive: {
    borderColor: colors.accent.hex,
    backgroundColor: colors.accent.hex + '22',
  },
  chipText: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  chipTextActive: {
    color: colors.accent.hex,
    fontWeight: '600',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  toggleLabel: {
    fontSize: 13,
    color: colors.ink.hex,
    flex: 1,
    marginRight: 12,
  },
  toggleTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.line.hex,
    padding: 2,
  },
  toggleTrackOn: {
    backgroundColor: colors.accent.hex,
  },
  toggleThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fff',
  },
  toggleThumbOn: {
    transform: [{ translateX: 18 }],
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
});
