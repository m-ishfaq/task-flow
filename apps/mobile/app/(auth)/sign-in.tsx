import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { apiClient, session } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';

/**
 * Password sign-in, with the TOTP second-factor challenge inline
 * (ai/phase-14-mobile.md §4.4).
 *
 * Talks to `auth.native.login` / `auth.native.totp.verifyLogin` — the
 * body-delivery routes (§4.3), never `auth.login`, which is browser-only by
 * construction (`SessionResponse` has no `refreshToken` field to adopt).
 *
 * What this deliberately does not have, mirroring apps/web's `LoginPage`: no
 * "no account found" message (`INVALID_CREDENTIALS` is identical for an
 * unknown address and a wrong password — Phase 1's enumeration defence), and
 * no client-side password strength check (that belongs to registration, not a
 * login attempt). Passkeys and OAuth are named in the spec (§4.4) and land in
 * a later increment — this screen covers the factor every account has today.
 */
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  const signIn = useMutation({
    mutationFn: () => apiClient.auth.native.login.mutate({ email, password }),
    onSuccess: async (result) => {
      if (result.kind === 'totp_required') {
        setChallengeToken(result.challengeToken);
        return;
      }
      await session.adopt(result);
    },
  });

  const verifyTotp = useMutation({
    mutationFn: () =>
      apiClient.auth.native.totp.verifyLogin.mutate({
        challengeToken: challengeToken ?? '',
        credential: { kind: 'totp', code },
      }),
    onSuccess: (tokens) => session.adopt(tokens),
  });

  if (challengeToken !== null) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Enter your code</Text>
        <Text style={styles.subtitle}>From your authenticator app.</Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="6-digit code"
          keyboardType="number-pad"
          autoFocus
          style={styles.input}
        />
        {verifyTotp.isError && <FormError error={verifyTotp.error} />}
        <Pressable
          style={styles.button}
          disabled={verifyTotp.isPending || code.length === 0}
          onPress={() => {
            verifyTotp.mutate();
          }}
        >
          {verifyTotp.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Verify</Text>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in to TaskFlow</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        style={styles.input}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        autoComplete="password"
        secureTextEntry
        style={styles.input}
      />
      {signIn.isError && <FormError error={signIn.error} />}
      <Pressable
        style={styles.button}
        disabled={signIn.isPending || email.length === 0 || password.length === 0}
        onPress={() => {
          signIn.mutate();
        }}
      >
        {signIn.isPending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
      </Pressable>
    </View>
  );
}

/** The server's own explanation of a failure, when it gave one — apps/web's `ErrorView`, minimal. */
function FormError({ error }: { readonly error: unknown }) {
  const message = apiErrorOf(error)?.error.message ?? 'Something went wrong. Please try again.';
  return (
    <Text style={styles.error} accessibilityRole="alert">
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#111',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#c00',
    fontSize: 14,
  },
});
