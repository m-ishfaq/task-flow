import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';

/**
 * The mobile counterpart of `apps/web/src/features/auth/step-up.tsx`'s
 * `StepUpDialog` — see `use-step-up.ts`'s own header for why this exists at
 * all and why it cannot be a silent token refresh. Re-authenticating IS
 * signing in again: this reruns the identical `auth.native.login` /
 * `auth.native.totp.verifyLogin` pair `(auth)/sign-in.tsx` already uses,
 * `session.adopt`s the fresh pair (a genuinely NEW `authenticatedAt`, which
 * is the one thing this whole control exists to bump), then calls
 * `onConfirmed` — the caller's queued retry — rather than navigating
 * anywhere, since the account screen the user was already on is exactly
 * where they should land back.
 *
 * A bottom-sheet `Modal` wrapped in `KeyboardAvoidingView`, matching
 * `(tabs)/chat.tsx`'s "New channel" sheet fix (this app's own README has the
 * full story of that bug) — a password/TOTP-code TextInput autofocusing
 * inside an unguarded sheet is the exact shape that broke there.
 */
export function StepUpSheet({
  visible,
  onConfirmed,
  onCancel,
}: {
  readonly visible: boolean;
  readonly onConfirmed: () => void;
  readonly onCancel: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  const reset = (): void => {
    setPassword('');
    setCode('');
    setChallengeToken(null);
  };

  const reauthenticate = useMutation({
    mutationFn: () => apiClient.auth.native.login.mutate({ email, password }),
    onSuccess: async (result) => {
      if (result.kind === 'totp_required') {
        setChallengeToken(result.challengeToken);
        return;
      }
      await session.adopt(result);
      reset();
      onConfirmed();
    },
  });

  const verifyTotp = useMutation({
    mutationFn: () =>
      apiClient.auth.native.totp.verifyLogin.mutate({
        challengeToken: challengeToken ?? '',
        credential: { kind: 'totp', code },
      }),
    onSuccess: async (tokens) => {
      await session.adopt(tokens);
      reset();
      onConfirmed();
    },
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        reset();
        onCancel();
      }}
    >
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => {
            reset();
            onCancel();
          }}
        >
          <Pressable style={styles.card} onPress={() => undefined}>
            <Text style={styles.title}>Confirm it is you</Text>
            <Text style={styles.hint}>
              This change affects your account&apos;s security, so it needs your password again.
            </Text>

            {challengeToken === null ? (
              <>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  placeholderTextColor={colors.inkFaint.hex}
                  style={styles.input}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Password"
                  placeholderTextColor={colors.inkFaint.hex}
                  style={styles.input}
                  secureTextEntry
                  autoComplete="current-password"
                />
                {reauthenticate.isError && (
                  <Text style={styles.error} accessibilityRole="alert">
                    {apiErrorOf(reauthenticate.error)?.error.message ??
                      'That did not match. Try again.'}
                  </Text>
                )}
                <Pressable
                  style={[
                    styles.submit,
                    (reauthenticate.isPending || email === '' || password === '') &&
                      styles.submitDisabled,
                  ]}
                  disabled={reauthenticate.isPending || email === '' || password === ''}
                  onPress={() => {
                    reauthenticate.mutate();
                  }}
                >
                  {reauthenticate.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.submitText}>Confirm</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.hint}>Enter the code from your authenticator app.</Text>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  placeholder="123456"
                  placeholderTextColor={colors.inkFaint.hex}
                  style={styles.input}
                  keyboardType="number-pad"
                  autoFocus
                />
                {verifyTotp.isError && (
                  <Text style={styles.error} accessibilityRole="alert">
                    {apiErrorOf(verifyTotp.error)?.error.message ?? 'That code did not work.'}
                  </Text>
                )}
                <Pressable
                  style={[
                    styles.submit,
                    (verifyTotp.isPending || code === '') && styles.submitDisabled,
                  ]}
                  disabled={verifyTotp.isPending || code === ''}
                  onPress={() => {
                    verifyTotp.mutate();
                  }}
                >
                  {verifyTotp.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.submitText}>Verify</Text>
                  )}
                </Pressable>
              </>
            )}

            <Pressable
              style={styles.cancel}
              onPress={() => {
                reset();
                onCancel();
              }}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  avoider: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  hint: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  error: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  submit: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard + 2,
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  cancel: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
