import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';

/**
 * Account creation — the native counterpart of `apps/web`'s `RegisterPage`,
 * ported for parity (`ai/phase-14-mobile.md` names sign-in only in Wave 1b;
 * this and `forgot-password.tsx` close the gap a real device run found: a
 * sign-in screen with no way to create an account or recover a password is
 * not the same experience web has).
 *
 * `auth.register` is unchanged from browser to native — it takes no session
 * and returns none (`{ status: 'verification_sent' }`), so there is nothing
 * channel-specific about it the way `auth.login` needed a `native.` sibling
 * for. Success does NOT sign anyone in: the address is unproven until the
 * emailed link is followed, so this renders a "check your email" state
 * rather than navigating anywhere.
 *
 * The confirmation copy is identical whether or not the address was already
 * registered, matching what the API does — a signup form that says "that
 * address is taken" is an account-existence oracle that needs no password
 * guesses at all.
 *
 * No field-level error extraction (web's `field-errors.ts`, reading a Zod
 * `details` bag per field): mobile's `FormError` convention everywhere else
 * (`sign-in.tsx`) is a single top-level message, and introducing a second
 * error-rendering shape for one screen would be its own small drift to
 * maintain for a form with three fields.
 */
export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const create = useMutation({
    mutationFn: () => apiClient.auth.register.mutate({ name: name.trim(), email, password }),
  });

  if (create.isSuccess) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          If that address can be registered, a verification link is on its way. The link is
          single-use and expires.
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
      <Text style={styles.title}>Create an account</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={colors.inkFaint.hex}
        autoComplete="name"
        style={styles.input}
      />
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
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor={colors.inkFaint.hex}
        autoComplete="new-password"
        secureTextEntry
        style={styles.input}
      />
      <Text style={styles.hint}>At least 12 characters. Checked against known breach corpora.</Text>
      {create.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(create.error)?.error.message ?? 'Something went wrong. Please try again.'}
        </Text>
      )}
      <Pressable
        style={styles.button}
        disabled={
          create.isPending || name.length === 0 || email.length === 0 || password.length === 0
        }
        onPress={() => {
          create.mutate();
        }}
      >
        {create.isPending ? (
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.buttonText}>Create account</Text>
        )}
      </Pressable>
      <Pressable
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.link}>Already have one? Sign in</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 14,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: colors.inkMuted.hex,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  hint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    marginTop: -4,
  },
  button: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard + 2,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: {
    color: colors.accentInk.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    color: colors.accent.hex,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 8,
  },
  error: {
    color: colors.danger.hex,
    fontSize: 13,
  },
});
