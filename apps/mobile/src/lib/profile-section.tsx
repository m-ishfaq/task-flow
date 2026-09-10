import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatDistanceToNow } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';

const ME_QUERY_KEY = ['auth.me'] as const;

/**
 * Display name, email, verification status — `apps/web`'s `AccountSection`,
 * ported. `auth.me` (read) and `people.profile.update` (write) are BOTH
 * `selfRoute` with no `stepUp` — a display name is not credential-adjacent
 * the way a password or a second factor is, so this needs none of the
 * `useStepUp` plumbing every other new section in this file does.
 *
 * `draft === null` means "not edited yet" rather than initializing from
 * `me.data.displayName` directly — the same discipline `card-patch.ts`'s
 * own header argues for a different reason (distinguishing "untouched"
 * from "touched to empty"): initializing eagerly would freeze the field at
 * whatever loaded first, and if that happens before the query settles, an
 * empty box would silently overwrite a real name on save.
 */
export function ProfileSection() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => wire(await apiClient.auth.me.query()),
  });
  const value = draft ?? me.data?.displayName ?? '';

  const save = useMutation({
    mutationFn: (displayName: string | null) =>
      apiClient.people.profile.update.mutate({ displayName }),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });

  if (me.isPending) {
    return (
      <View style={styles.section}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }
  if (me.isError) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(me.error)?.error.message ?? "Couldn't load your account."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Profile</Text>
      <Text style={styles.sectionHint}>
        How your name appears to everyone else, in every organization.
      </Text>

      <Text style={styles.fieldLabel}>Email</Text>
      <View style={styles.disabledInput}>
        <Text style={styles.disabledInputText}>{me.data.email}</Text>
      </View>

      <Text style={styles.fieldLabel}>Display name</Text>
      <TextInput
        value={value}
        onChangeText={setDraft}
        placeholder="Your name"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.input}
        maxLength={80}
      />
      <Text style={styles.sectionHint}>Leave empty to be shown by your email address instead.</Text>

      <View style={styles.footerRow}>
        <Pressable
          style={styles.saveButton}
          disabled={save.isPending}
          onPress={() => {
            const trimmed = value.trim();
            save.mutate(trimmed === '' ? null : trimmed);
          }}
        >
          {save.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.saveButtonText}>Save</Text>
          )}
        </Pressable>
        <View style={me.data.emailVerified ? styles.badgeOn : styles.badgeWarning}>
          <Text style={me.data.emailVerified ? styles.badgeOnText : styles.badgeWarningText}>
            {me.data.emailVerified ? 'Email verified' : 'Email not verified'}
          </Text>
        </View>
      </View>
      <Text style={styles.sectionHint}>
        Member since {formatDistanceToNow(new Date(me.data.createdAt), { addSuffix: true })}
      </Text>

      {save.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(save.error)?.error.message ?? 'Your name was not saved.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
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
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    marginTop: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  disabledInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surfaceHover.hex + '80',
  },
  disabledInputText: {
    fontSize: 14,
    color: colors.inkMuted.hex,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  saveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  badgeOn: {
    backgroundColor: colors.success.hex + '26',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeOnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success.hex,
  },
  badgeWarning: {
    backgroundColor: colors.warning.hex + '26',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeWarningText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.warning.hex,
  },
});
