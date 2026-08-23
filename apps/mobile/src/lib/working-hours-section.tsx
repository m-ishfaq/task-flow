import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire, type Wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import type { MobileTRPCClient } from './trpc-client.js';

const PROFILE_QUERY_KEY = ['people.profile.get'] as const;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type ProfileView = Wire<Awaited<ReturnType<MobileTRPCClient['people']['profile']['get']['query']>>>;

interface Draft {
  readonly timezone: string | null;
  readonly workingHoursStart: string | null;
  readonly workingHoursEnd: string | null;
  readonly workingDays: readonly number[];
  readonly oooFrom: string | null;
  readonly oooUntil: string | null;
  readonly oooMessage: string | null;
}

/**
 * `oooFrom`/`oooUntil` arrive over the wire as full ISO instants (a `z.date()`
 * output, JSON-serialized) — sliced to their leading `YYYY-MM-DD` for
 * display, the same treatment web's `value.oooFrom?.slice(0, 10)` gives the
 * identical field, so a reloaded value re-populates the date typed in
 * rather than a raw timestamp.
 */
function draftOf(profile: ProfileView | undefined): Draft {
  return {
    timezone: profile?.timezone ?? null,
    workingHoursStart: profile?.workingHoursStart ?? null,
    workingHoursEnd: profile?.workingHoursEnd ?? null,
    workingDays: profile?.workingDays ?? [],
    oooFrom: profile?.oooFrom?.slice(0, 10) ?? null,
    oooUntil: profile?.oooUntil?.slice(0, 10) ?? null,
    oooMessage: profile?.oooMessage ?? null,
  };
}

/**
 * Timezone, working hours, working days, and out-of-office —
 * `apps/web`'s `WorkingHoursSection`, ported. Uses `people.profile.get`,
 * not `auth.me`: the merged view carries the fields the identity shape
 * deliberately does not.
 *
 * Time and date fields are plain text (`HH:MM`, `YYYY-MM-DD`) rather than
 * native pickers — the same call `card/[cardId].tsx`'s own header already
 * makes for due/start dates ("no date-picker dependency has been added
 * yet"), still true here; this session already added two new native
 * dependencies (icons, the TOTP QR renderer) and a third for two rarely-
 * touched fields is not a call to make silently inside this port. The
 * server re-validates either way, so a malformed value is a field error,
 * not a client-side illusion of correctness.
 */
export function WorkingHoursSection() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const profile = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => wire(await apiClient.people.profile.get.query()),
  });
  const value = draft ?? draftOf(profile.data);
  const saved = draftOf(profile.data);
  const dirty =
    draft !== null &&
    JSON.stringify({ ...draft, workingDays: [...draft.workingDays].sort() }) !==
      JSON.stringify({ ...saved, workingDays: [...saved.workingDays].sort() });

  const save = useMutation({
    mutationFn: (patch: Draft) => apiClient.people.profile.update.mutate(patch),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['auth.me'] });
    },
  });

  const toggleDay = (day: number): void => {
    setDraft({
      ...value,
      workingDays: value.workingDays.includes(day)
        ? value.workingDays.filter((existing) => existing !== day)
        : [...value.workingDays, day].sort((a, b) => a - b),
    });
  };

  if (profile.isPending) {
    return (
      <View style={styles.section}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }
  if (profile.isError) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(profile.error)?.error.message ?? "Couldn't load your working hours."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Working hours &amp; timezone</Text>
      <Text style={styles.sectionHint}>
        Your working week and where you are — shown on your profile and used for scheduling.
      </Text>

      <Text style={styles.fieldLabel}>Timezone</Text>
      <TextInput
        value={value.timezone ?? ''}
        onChangeText={(text) => {
          setDraft({ ...value, timezone: text.trim() === '' ? null : text });
        }}
        placeholder="e.g. America/Chicago"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.input}
        autoCapitalize="none"
      />

      <View style={styles.hoursRow}>
        <View style={styles.hoursField}>
          <Text style={styles.fieldLabel}>Work starts</Text>
          <TextInput
            value={value.workingHoursStart ?? ''}
            onChangeText={(text) => {
              setDraft({ ...value, workingHoursStart: text.trim() === '' ? null : text });
            }}
            placeholder="09:00"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.input}
          />
        </View>
        <View style={styles.hoursField}>
          <Text style={styles.fieldLabel}>Work ends</Text>
          <TextInput
            value={value.workingHoursEnd ?? ''}
            onChangeText={(text) => {
              setDraft({ ...value, workingHoursEnd: text.trim() === '' ? null : text });
            }}
            placeholder="17:00"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.input}
          />
        </View>
      </View>

      <Text style={styles.fieldLabel}>Working days</Text>
      <View style={styles.dayRow}>
        {DAY_LABELS.map((label, index) => {
          const dayNumber = index + 1;
          const active = value.workingDays.includes(dayNumber);
          return (
            <Pressable
              key={label}
              style={[styles.dayChip, active && styles.dayChipActive]}
              onPress={() => {
                toggleDay(dayNumber);
              }}
            >
              <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.hoursRow}>
        <View style={styles.hoursField}>
          <Text style={styles.fieldLabel}>Out of office from</Text>
          <TextInput
            value={value.oooFrom ?? ''}
            onChangeText={(text) => {
              setDraft({ ...value, oooFrom: text.trim() === '' ? null : text });
            }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.input}
          />
        </View>
        <View style={styles.hoursField}>
          <Text style={styles.fieldLabel}>Returning</Text>
          <TextInput
            value={value.oooUntil ?? ''}
            onChangeText={(text) => {
              setDraft({ ...value, oooUntil: text.trim() === '' ? null : text });
            }}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.input}
          />
        </View>
      </View>

      <Text style={styles.fieldLabel}>Out-of-office message</Text>
      <TextInput
        value={value.oooMessage ?? ''}
        onChangeText={(text) => {
          setDraft({ ...value, oooMessage: text });
        }}
        placeholder="e.g. On leave, back with you soon"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.input}
        maxLength={200}
      />

      <View style={styles.footerRow}>
        <Pressable
          style={[styles.saveButton, (!dirty || save.isPending) && styles.saveButtonDisabled]}
          disabled={!dirty || save.isPending}
          onPress={() => {
            save.mutate(value);
          }}
        >
          {save.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.saveButtonText}>Save working hours</Text>
          )}
        </Pressable>
        {dirty && (
          <Pressable
            onPress={() => {
              setDraft(null);
            }}
          >
            <Text style={styles.discardText}>Discard</Text>
          </Pressable>
        )}
      </View>

      {save.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(save.error)?.error.message ?? 'Your working hours were not saved.'}
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
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  hoursRow: {
    flexDirection: 'row',
    gap: 8,
  },
  hoursField: {
    flex: 1,
  },
  dayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  dayChip: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  dayChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  dayChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  dayChipTextActive: {
    color: colors.accentInk.hex,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  saveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  discardText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
