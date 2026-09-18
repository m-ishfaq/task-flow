import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';

/**
 * Self-serve DSAR export — `apps/web`'s `ExportDataSection`, ported.
 * `people.profile.exportMine` is a tRPC QUERY, but called on demand from a
 * button press rather than auto-fetched on mount, the same choice web's own
 * header notes explicitly (wrapped in a mutation there too, for the
 * identical reason: a query route invoked as a user ACTION, not data the
 * screen needs to render).
 *
 * `Share.share` (React Native core, zero new dependencies) is the mobile
 * equivalent of web's `Blob`-and-anchor download — the same pattern
 * `channel-details/[channelId].tsx`'s own compliance export already
 * established for this app. No `stepUp` on the route: reading your own
 * account data is not credential-adjacent the way changing a credential is.
 */
export function ExportDataSection() {
  const exportData = useMutation({
    mutationFn: async () => wire(await apiClient.people.profile.exportMine.query()),
    onSuccess: (result) => {
      void Share.share({
        title: `rinavai-data-export-${result.exportedAt.slice(0, 10)}.json`,
        message: JSON.stringify(result, null, 2),
      });
    },
  });

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Export your data</Text>
      <Text style={styles.sectionHint}>
        Download everything tied to your account — profile, memberships, sessions, and connected
        accounts — as one JSON document.
      </Text>
      <Pressable
        style={styles.exportButton}
        disabled={exportData.isPending}
        onPress={() => {
          exportData.mutate();
        }}
      >
        {exportData.isPending ? (
          <ActivityIndicator color={colors.ink.hex} />
        ) : (
          <Text style={styles.exportButtonText}>Export my data</Text>
        )}
      </Pressable>
      {exportData.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(exportData.error)?.error.message ?? 'The export could not be created.'}
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
  exportButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingVertical: 10,
    alignItems: 'center',
  },
  exportButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
});
