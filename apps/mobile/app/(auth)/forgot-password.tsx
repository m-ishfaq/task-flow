import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';

/**
 * Requesting a password-reset link — the native counterpart of `apps/web`'s
 * `ForgotPasswordPage`. See `register.tsx`'s own header for why this and
 * that screen exist now.
 *
 * The confirmation is identical whether or not the address has an account,
 * matching the API's `{ status: 'sent' }` either way — an
 * account-existence oracle needs no password guesses at all.
 *
 * There is deliberately no `reset-password.tsx` to receive the emailed link:
 * `packages/mail/src/templates.ts` builds that link against the WEB app's
 * own base URL (`link(context, '/reset-password')`), not a `taskflow://`
 * deep link, so the link opens in a browser regardless of which surface the
 * request came from — nothing here needs a token-handling screen, or the
 * universal-link infrastructure passkeys' own README section names as not
 * set up yet.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');

  const request = useMutation({
    mutationFn: () => apiClient.auth.requestPasswordReset.mutate({ email }),
  });

  if (request.isSuccess) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          If that address has an account, a reset link is on its way. The link is single-use and
          expires.
        </Text>
        <Pressable
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.link}>Back to sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reset your password</Text>
      <Text style={styles.subtitle}>We will email you a link to choose a new one.</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.inkFaint.hex}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        style={styles.input}
      />
      {request.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(request.error)?.error.message ?? 'Something went wrong. Please try again.'}
        </Text>
      )}
      <Pressable
        style={styles.button}
        disabled={request.isPending || email.length === 0}
        onPress={() => {
          request.mutate();
        }}
      >
        {request.isPending ? (
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.buttonText}>Send reset link</Text>
        )}
      </Pressable>
      <Pressable
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.link}>Back to sign in</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 4,
    color: colors.ink.hex,
  },
  subtitle: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  button: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: colors.accentInk.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    color: colors.accent.hex,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
});
