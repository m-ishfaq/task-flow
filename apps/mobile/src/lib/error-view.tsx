import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radiusCard } from '@taskflow/tokens';

/**
 * Design Bible §17's "ERROR · RETRYABLE" state, ported — the one system
 * state web has always had (`apps/web/src/components/error-view.tsx`'s
 * `ErrorView`) and mobile never did: every screen that can fail hand-rolled
 * its own bare `<Text accessibilityRole="alert">`, which works for a
 * one-line hint under a button but reads as an afterthought for "this
 * whole screen has nothing to show." A danger-tinted icon, a title, the
 * server's own message, and — when the caller has something to retry — a
 * real "Try again" button, matching the mockup's own shape rather than a
 * plain sentence.
 *
 * `onRetry` is optional: a screen with nothing sensible to re-run (most
 * `useQuery` failures are re-run by pulling to refresh, or by the query
 * itself retrying) can render this with no button at all, just the
 * explanation.
 */
export function ErrorView({
  title = "Couldn't load this.",
  message,
  onRetry,
  retrying = false,
}: {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}): ReactNode {
  return (
    <View style={styles.container}>
      <View style={styles.icon}>
        <Ionicons name="warning" size={20} color={colors.danger.hex} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message} accessibilityRole="alert">
        {message}
      </Text>
      {onRetry !== undefined && (
        <Pressable style={styles.button} disabled={retrying} onPress={onRetry}>
          {retrying ? (
            <ActivityIndicator color={colors.ink.hex} />
          ) : (
            <Text style={styles.buttonText}>Try again</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.danger.hex + '18',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  message: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  button: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: colors.surfaceRaised.hex,
  },
  buttonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
});
