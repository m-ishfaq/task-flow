import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistanceToNow } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useStepUp } from './use-step-up.js';
import { StepUpSheet } from './step-up-sheet.js';

const SESSIONS_QUERY_KEY = ['auth.sessions.list'] as const;

/**
 * Device/session inventory — `apps/web`'s `SessionsSection`, ported.
 * `auth.sessions.list` is `selfRoute` (a plain read); `revoke` (one device)
 * and `auth.logoutEverywhere` (every device, including this one) are both
 * `stepUp: true`, so both route through this section's own `useStepUp`
 * guard exactly like `connected-accounts-section.tsx`.
 *
 * **`logoutEverywhere` never calls `session.signOut()`.** That method also
 * calls `auth.logout` with THIS device's own refresh token — redundant
 * (the server already revoked every session, including this one) and
 * pointless to await, since the very token it would send is one of the
 * ones just revoked. `session.clear()` is the correct local half: it drops
 * the stored refresh token and flips `status` to `'anonymous'` with no
 * server round trip, and `(app)/_layout.tsx`'s own gate already redirects
 * to `/sign-in` the instant `status` is not `'authenticated'` — the same
 * mechanism the ordinary "Sign out" button relies on, so no explicit
 * navigation call belongs here either.
 */
export function SessionsSection() {
  const queryClient = useQueryClient();
  const { guard, pending, confirm, cancel } = useStepUp();

  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.auth.sessions.list.query()),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  };

  const revoke = useMutation({
    mutationFn: (sessionId: string) => apiClient.auth.sessions.revoke.mutate({ sessionId }),
    onSuccess: refresh,
  });
  const runRevoke = (sessionId: string): void => {
    revoke.mutate(sessionId, {
      onError: (error) => {
        guard(error, () => {
          runRevoke(sessionId);
        });
      },
    });
  };

  const logoutEverywhere = useMutation({
    mutationFn: () => apiClient.auth.logoutEverywhere.mutate(),
    onSuccess: async () => {
      await session.clear();
    },
  });
  const runLogoutEverywhere = (): void => {
    logoutEverywhere.mutate(undefined, {
      onError: (error) => {
        guard(error, runLogoutEverywhere);
      },
    });
  };

  const rows = sessions.data?.sessions ?? [];

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Devices &amp; sessions</Text>

      {sessions.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : sessions.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(sessions.error)?.error.message ?? "Couldn't load your sessions."}
        </Text>
      ) : (
        <>
          {rows.map((row) => (
            <View key={row.id} style={styles.row}>
              <View style={styles.rowBody}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {row.label ?? 'Unknown device'}
                  </Text>
                  {row.isCurrent && (
                    <View style={styles.currentBadge}>
                      <Text style={styles.currentBadgeText}>This device</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.rowMeta}>
                  {row.ip ?? 'No IP recorded'} · signed in{' '}
                  {formatDistanceToNow(new Date(row.authenticatedAt), { addSuffix: true })} · last
                  seen {formatDistanceToNow(new Date(row.lastSeenAt), { addSuffix: true })}
                </Text>
                {row.flagged && (
                  <Text style={styles.flaggedText}>
                    Unusual sign-in{row.country === null ? '' : ` from ${row.country}`}
                  </Text>
                )}
              </View>
              <Pressable
                disabled={revoke.isPending}
                onPress={() => {
                  runRevoke(row.id);
                }}
              >
                <Text style={styles.revokeText}>Sign out</Text>
              </Pressable>
            </View>
          ))}

          {sessions.data.pushDeviceCount > 0 && (
            <Text style={styles.sectionHint}>
              Push notifications are active on {sessions.data.pushDeviceCount}{' '}
              {sessions.data.pushDeviceCount === 1 ? 'device' : 'devices'}.
            </Text>
          )}

          {revoke.isError && (
            <Text style={styles.sectionError} accessibilityRole="alert">
              {apiErrorOf(revoke.error)?.error.message ?? 'That device could not be signed out.'}
            </Text>
          )}

          {rows.length > 1 && (
            <Pressable
              style={styles.logoutEverywhereButton}
              disabled={logoutEverywhere.isPending}
              onPress={runLogoutEverywhere}
            >
              {logoutEverywhere.isPending ? (
                <ActivityIndicator color={colors.danger.hex} />
              ) : (
                <Text style={styles.logoutEverywhereText}>Sign out everywhere</Text>
              )}
            </Pressable>
          )}
          {logoutEverywhere.isError && (
            <Text style={styles.sectionError} accessibilityRole="alert">
              {apiErrorOf(logoutEverywhere.error)?.error.message ??
                'Could not sign out every device.'}
            </Text>
          )}
        </>
      )}

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
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
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 6,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowLabel: {
    fontSize: 14,
    color: colors.ink.hex,
    flexShrink: 1,
  },
  currentBadge: {
    backgroundColor: colors.accent.hex + '15',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  currentBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  rowMeta: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  flaggedText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.warning.hex,
  },
  revokeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  logoutEverywhereButton: {
    borderWidth: 1,
    borderColor: colors.danger.hex + '40',
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
    backgroundColor: colors.danger.hex + '08',
  },
  logoutEverywhereText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
