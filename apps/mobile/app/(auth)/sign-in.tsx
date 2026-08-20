import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import {
  OAUTH_PROVIDER_LABEL,
  OAUTH_REDIRECT_URL,
  parseOAuthRedirect,
  type OAuthProvider,
} from '../../src/lib/oauth.js';

/**
 * Password sign-in, with the TOTP second-factor challenge inline, and OAuth
 * (ai/phase-14-mobile.md §4.4).
 *
 * Talks to `auth.native.login` / `auth.native.totp.verifyLogin` /
 * `auth.native.oauth.*` — the body-delivery routes (§4.3), never
 * `auth.login`/`auth.oauth.*`, which are browser-only by construction
 * (`SessionResponse` has no `refreshToken` field to adopt).
 *
 * What this deliberately does not have, mirroring apps/web's `LoginPage`: no
 * "no account found" message (`INVALID_CREDENTIALS` is identical for an
 * unknown address and a wrong password — Phase 1's enumeration defence), and
 * no client-side password strength check (that belongs to registration, not a
 * login attempt). Passkeys are named in the spec too and land in a later
 * increment — this screen now covers every factor except that one.
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

  const oauthProviders = useQuery({
    queryKey: ['auth.native.oauth.providers'],
    queryFn: () => apiClient.auth.native.oauth.providers.query(),
  });

  /**
   * Opens the provider's consent screen in a system-browser session and
   * waits for it to redirect back to `OAUTH_REDIRECT_URL` — see
   * `src/lib/oauth.ts`'s header for why that does not need a router route.
   * A `result.type !== 'success'` is the user backing out of the browser, a
   * routine cancel rather than a failure, so it resolves to `null` instead
   * of throwing — the mutation settles quietly with nothing to show.
   */
  const oauth = useMutation({
    mutationFn: async (provider: OAuthProvider) => {
      const { authorizationUrl } = await apiClient.auth.native.oauth.start.mutate({ provider });
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, OAUTH_REDIRECT_URL);
      if (result.type !== 'success') return null;

      const parsed = parseOAuthRedirect(result.url);
      if (parsed === null) {
        throw new Error('The sign-in provider did not return a valid response.');
      }
      return apiClient.auth.native.oauth.callback.mutate({ provider, ...parsed });
    },
    onSuccess: async (result) => {
      if (result?.kind === 'session') await session.adopt(result);
    },
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
          placeholderTextColor={colors.inkFaint.hex}
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
            <ActivityIndicator color={colors.accentInk.hex} />
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
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
      </Pressable>
      {oauth.isError && <FormError error={oauth.error} />}
      {(['google', 'github'] as const)
        .filter((provider) => oauthProviders.data?.[provider] === true)
        .map((provider) => (
          <Pressable
            key={provider}
            style={styles.oauthButton}
            disabled={oauth.isPending}
            onPress={() => {
              oauth.mutate(provider);
            }}
          >
            {oauth.isPending && oauth.variables === provider ? (
              <ActivityIndicator color={colors.ink.hex} />
            ) : (
              <Text style={styles.oauthButtonText}>
                Continue with {OAUTH_PROVIDER_LABEL[provider]}
              </Text>
            )}
          </Pressable>
        ))}
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
  oauthButton: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  oauthButtonText: {
    color: colors.ink.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
});
