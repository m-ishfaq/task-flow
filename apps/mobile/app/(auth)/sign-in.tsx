import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../src/lib/app-session.js';
import { apiErrorOf, errorCodeOf, errorMessageOf } from '../../src/lib/trpc-client.js';
import { useIsOffline } from '../../src/lib/use-network-status.js';
import { loadPasskeys } from '../../src/lib/passkeys.js';
import {
  OAUTH_PROVIDER_LABEL,
  OAUTH_REDIRECT_URL,
  parseOAuthRedirect,
  type OAuthProvider,
} from '../../src/lib/oauth.js';
import { createPkceChallenge } from '../../src/lib/oauth-pkce.native.js';
import { useBranding } from '../../src/lib/branding-context.js';
import { BrandMark } from '../../src/lib/brand-mark.js';

/**
 * Password sign-in, with the TOTP second-factor challenge inline, OAuth, and
 * passkeys (ai/phase-14-mobile.md §4.4).
 *
 * Talks to `auth.native.login` / `auth.native.totp.verifyLogin` /
 * `auth.native.oauth.*` / `auth.native.passkeys.finishAuthentication` — the
 * body-delivery routes (§4.3), never their browser counterparts, which are
 * browser-only by construction (`SessionResponse` has no `refreshToken`
 * field to adopt). `auth.passkeys.startAuthentication` is the one exception,
 * shared with the browser route unchanged: it mints ceremony options with no
 * session and nothing channel-specific — see `router.ts`'s own comment on
 * why only `finishAuthentication` needed a native counterpart at all.
 *
 * What this deliberately does not have, mirroring apps/web's `LoginPage`: no
 * "no account found" message (`INVALID_CREDENTIALS` is identical for an
 * unknown address and a wrong password — Phase 1's enumeration defence), and
 * no client-side password strength check (that belongs to registration, not a
 * login attempt).
 */
export default function SignIn() {
  const { productName } = useBranding();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [passkeySupported, setPasskeySupported] = useState(false);

  /* `isSupported()` used to be called synchronously inline in JSX, which
     only worked because the module was imported statically — exactly the
     import this file no longer does (see passkeys.ts's header). Loading it
     lazily means "is a passkey usable here" can only be answered once that
     load settles, so it becomes state resolved after mount instead of a
     synchronous call; a failed load (module not linked) leaves it `false`,
     the same as "no passkey support" reads today. */
  useEffect(() => {
    let cancelled = false;
    loadPasskeys()
      .then((mod) => {
        if (!cancelled) setPasskeySupported(mod.isSupported());
      })
      .catch(() => {
        if (!cancelled) setPasskeySupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /* The way out of EMAIL_NOT_VERIFIED, ported from apps/web's `LoginPage`
     (see that file's own comment): the account exists and the password was
     correct — `login` only reaches this error after confirming both — so
     there is a real inbox to send another link to. `resendVerification`
     answers `{ status: 'sent' }` unconditionally either way, so this never
     itself reveals anything `signIn`'s own error did not already.
     Reads the live `email` field state rather than web's `signIn.variables
     ?.email` — `signIn`'s own `mutationFn` here takes no argument (it
     closes over the same state), so there is no captured-at-submit-time
     value to read instead; the field cannot have changed between a failed
     attempt and pressing this button without the user clearing the error
     some other way first, so the two reads coincide in practice. */
  const resendVerification = useMutation({
    mutationFn: () => apiClient.auth.resendVerification.mutate({ email }),
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
      /* The client-held binding (`oauth.ts`'s own section header): only the
         challenge crosses to `start`, and `verifier` never leaves this closure
         until `callback`. An app that intercepted the custom-scheme redirect
         holds `(code, state)` and still cannot redeem them without it. */
      const { verifier, challenge } = await createPkceChallenge();
      const { authorizationUrl } = await apiClient.auth.native.oauth.start.mutate({
        provider,
        clientChallenge: challenge,
      });
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, OAUTH_REDIRECT_URL);
      if (result.type !== 'success') return null;

      const parsed = parseOAuthRedirect(result.url);
      if (parsed === null) {
        throw new Error('The sign-in provider did not return a valid response.');
      }
      return apiClient.auth.native.oauth.callback.mutate({
        provider,
        ...parsed,
        clientVerifier: verifier,
      });
    },
    onSuccess: async (result) => {
      if (result?.kind === 'session') await session.adopt(result);
    },
  });

  /**
   * `startAuthentication` asks for no identifier at all — a discoverable
   * credential means the ceremony already knows who it is once the OS
   * finds a matching passkey, so there is nothing here to enumerate
   * accounts with. `result === null` is the user cancelling the platform
   * sheet, the same routine-cancel-not-a-failure shape as the OAuth
   * mutation above.
   */
  const passkey = useMutation({
    mutationFn: async () => {
      const options = await apiClient.auth.passkeys.startAuthentication.mutate();
      const { get } = await loadPasskeys();
      const result = await get(options as never);
      if (result === null) return null;
      // The library's own AuthenticationResponseJSON type and the server's
      // generated input type describe the identical WebAuthn wire shape
      // under two different, non-identical TypeScript declarations (one
      // from react-native-passkeys, one from the Zod schema) — the same
      // boundary the server itself crosses with `input.response as never`
      // in passkey.router.ts.
      return apiClient.auth.native.passkeys.finishAuthentication.mutate({
        response: result as never,
      });
    },
    onSuccess: async (result) => {
      if (result !== null) await session.adopt(result);
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
      <View style={styles.brandMark}>
        <BrandMark size={48} />
      </View>
      <Text style={styles.title}>Sign in to {productName}</Text>
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
      {signIn.isError &&
        (errorCodeOf(signIn.error) === 'EMAIL_NOT_VERIFIED' ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {apiErrorOf(signIn.error)?.error.message ??
                'Please verify your email address before signing in.'}
            </Text>
            {resendVerification.isSuccess ? (
              <Text style={styles.hint}>
                If that address has an account, a new link is on its way.
              </Text>
            ) : (
              <Pressable
                style={styles.secondaryButton}
                disabled={resendVerification.isPending}
                onPress={() => {
                  resendVerification.mutate();
                }}
              >
                {resendVerification.isPending ? (
                  <ActivityIndicator color={colors.ink.hex} />
                ) : (
                  <Text style={styles.secondaryButtonText}>Resend verification email</Text>
                )}
              </Pressable>
            )}
            {resendVerification.isError && <FormError error={resendVerification.error} />}
          </View>
        ) : (
          <FormError error={signIn.error} />
        ))}
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
      <View style={styles.linkRow}>
        <Pressable
          onPress={() => {
            router.push('/register');
          }}
        >
          <Text style={styles.link}>Create an account</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            router.push('/forgot-password');
          }}
        >
          <Text style={styles.link}>Forgot password?</Text>
        </Pressable>
      </View>
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
      {passkey.isError && <FormError error={passkey.error} />}
      {passkeySupported && (
        <Pressable
          style={styles.oauthButton}
          disabled={passkey.isPending}
          onPress={() => {
            passkey.mutate();
          }}
        >
          {passkey.isPending ? (
            <ActivityIndicator color={colors.ink.hex} />
          ) : (
            <Text style={styles.oauthButtonText}>Sign in with a passkey</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/** The server's own explanation of a failure, when it gave one — apps/web's `ErrorView`, minimal. */
function FormError({ error }: { readonly error: unknown }) {
  const isOffline = useIsOffline();
  const message = errorMessageOf(error, isOffline);
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
    gap: 14,
    backgroundColor: colors.surface.hex,
  },
  brandMark: {
    marginBottom: 4,
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
    marginBottom: 8,
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
  oauthButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    backgroundColor: colors.surfaceRaised.hex,
  },
  oauthButtonText: {
    color: colors.ink.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 13,
  },
  notice: {
    borderWidth: 1,
    borderColor: colors.warning.hex + '30',
    borderRadius: radiusCard,
    backgroundColor: colors.warning.hex + '10',
    padding: 14,
    gap: 8,
  },
  noticeText: {
    color: colors.ink.hex,
    fontSize: 14,
  },
  hint: {
    color: colors.inkMuted.hex,
    fontSize: 12,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  link: {
    color: colors.accent.hex,
    fontSize: 14,
    fontWeight: '500',
  },
});
