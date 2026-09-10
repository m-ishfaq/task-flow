import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useStepUp } from './use-step-up.js';
import { StepUpSheet } from './step-up-sheet.js';
import { QrCode } from './qr-code.js';

const TOTP_STATUS_QUERY_KEY = ['auth.totp.status'] as const;

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'enrolling'; readonly secret: string; readonly otpauthUrl: string }
  | { readonly kind: 'codes'; readonly codes: readonly string[] };

/**
 * Two-factor authentication (TOTP) — `apps/web`'s `totp-section.tsx`,
 * ported. Same three-stage wizard, held as local component state rather
 * than derived from a route, because the server has no notion of
 * "enrollment in progress" beyond the unconfirmed row `startEnrollment`
 * writes: `idle` → `enrolling` (secret + QR + code entry) → `codes`
 * (recovery codes, shown exactly once). Abandoning mid-enrollment and
 * reloading drops back to `idle` on purpose — `totp.service.ts`'s own
 * header on why an unconfirmed row is safe (unusable for login or
 * step-up) — not a bug to route around.
 *
 * `start`/`confirm`/`disable` are all `stepUp: true` server-side; `status`
 * is not (a cheap read the screen needs on every load just to decide which
 * button to render — gating it would make the account screen demand a
 * fresh credential before it can even show its own state). All three
 * mutations route their `onError` through this section's own `useStepUp`
 * guard, the same shape every other section in this file uses.
 */
export function TotpSection() {
  const queryClient = useQueryClient();
  const { guard, pending, confirm: confirmStepUp, cancel } = useStepUp();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [code, setCode] = useState('');

  const status = useQuery({
    queryKey: TOTP_STATUS_QUERY_KEY,
    queryFn: () => apiClient.auth.totp.status.query(),
  });

  const refreshStatus = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: TOTP_STATUS_QUERY_KEY });
  };

  const start = useMutation({
    mutationFn: () => apiClient.auth.totp.startEnrollment.mutate(),
    onSuccess: (result) => {
      setStage({ kind: 'enrolling', secret: result.secret, otpauthUrl: result.otpauthUrl });
    },
  });
  const runStart = (): void => {
    start.mutate(undefined, {
      onError: (error) => {
        guard(error, runStart);
      },
    });
  };

  const confirmEnrollment = useMutation({
    mutationFn: (submittedCode: string) =>
      apiClient.auth.totp.confirmEnrollment.mutate({ code: submittedCode }),
    onSuccess: async (result) => {
      setStage({ kind: 'codes', codes: result.recoveryCodes });
      setCode('');
      await refreshStatus();
    },
  });
  const runConfirm = (submittedCode: string): void => {
    confirmEnrollment.mutate(submittedCode, {
      onError: (error) => {
        guard(error, () => {
          runConfirm(submittedCode);
        });
      },
    });
  };

  const disable = useMutation({
    mutationFn: () => apiClient.auth.totp.disable.mutate(),
    onSuccess: async () => {
      setStage({ kind: 'idle' });
      await refreshStatus();
    },
  });
  const runDisable = (): void => {
    disable.mutate(undefined, {
      onError: (error) => {
        guard(error, runDisable);
      },
    });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Two-factor authentication</Text>
      <Text style={styles.sectionHint}>
        Require a code from an authenticator app, in addition to your password, when signing in.
      </Text>

      {status.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : status.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(status.error)?.error.message ?? "Couldn't load your two-factor status."}
        </Text>
      ) : (
        stage.kind === 'idle' && (
          <>
            <View style={styles.statusRow}>
              <View style={status.data.enabled ? styles.badgeOn : styles.badgeOff}>
                <Text style={status.data.enabled ? styles.badgeOnText : styles.badgeOffText}>
                  {status.data.enabled ? 'Enabled' : 'Not enabled'}
                </Text>
              </View>
              {status.data.enabled ? (
                <Pressable disabled={disable.isPending} onPress={runDisable}>
                  {disable.isPending ? (
                    <ActivityIndicator color={colors.danger.hex} />
                  ) : (
                    <Text style={styles.disableText}>Disable</Text>
                  )}
                </Pressable>
              ) : (
                <Pressable
                  style={styles.enableButton}
                  disabled={start.isPending}
                  onPress={runStart}
                >
                  {start.isPending ? (
                    <ActivityIndicator color={colors.ink.hex} />
                  ) : (
                    <Text style={styles.enableButtonText}>Enable two-factor authentication</Text>
                  )}
                </Pressable>
              )}
            </View>
            {start.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(start.error)?.error.message ?? 'Could not start enrollment.'}
              </Text>
            )}
            {disable.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(disable.error)?.error.message ?? 'Could not disable two-factor.'}
              </Text>
            )}
          </>
        )
      )}

      {stage.kind === 'enrolling' && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>
            Scan this into an authenticator app (Google Authenticator, 1Password, or similar), or
            enter the code manually if it cannot scan:
          </Text>
          <View style={styles.qrFrame}>
            <QrCode value={stage.otpauthUrl} size={160} />
          </View>
          <Text style={styles.secretText} selectable>
            {stage.secret}
          </Text>

          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Code from the app"
            placeholderTextColor={colors.inkFaint.hex}
            style={styles.codeInput}
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          <View style={styles.panelActions}>
            <Pressable
              style={[
                styles.confirmButton,
                (confirmEnrollment.isPending || code === '') && styles.confirmButtonDisabled,
              ]}
              disabled={confirmEnrollment.isPending || code === ''}
              onPress={() => {
                if (code !== '') runConfirm(code);
              }}
            >
              {confirmEnrollment.isPending ? (
                <ActivityIndicator color={colors.accentInk.hex} />
              ) : (
                <Text style={styles.confirmButtonText}>Confirm</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setStage({ kind: 'idle' });
                setCode('');
              }}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
          {confirmEnrollment.isError && (
            <Text style={styles.sectionError} accessibilityRole="alert">
              {apiErrorOf(confirmEnrollment.error)?.error.message ?? 'That code did not work.'}
            </Text>
          )}
        </View>
      )}

      {stage.kind === 'codes' && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>
            Two-factor authentication is on. Save these recovery codes somewhere safe — each works
            once, if you ever lose access to your authenticator app, and this is the only time they
            are shown.
          </Text>
          <View style={styles.codesGrid}>
            {stage.codes.map((recoveryCode) => (
              <Text key={recoveryCode} style={styles.codeText} selectable>
                {recoveryCode}
              </Text>
            ))}
          </View>
          <Pressable
            style={styles.doneButton}
            onPress={() => {
              setStage({ kind: 'idle' });
            }}
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
        </View>
      )}

      <StepUpSheet visible={pending} onConfirmed={confirmStepUp} onCancel={cancel} />
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  badgeOn: {
    backgroundColor: colors.success.hex + '26',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeOnText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success.hex,
  },
  badgeOff: {
    backgroundColor: colors.surfaceHover.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeOffText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  enableButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  enableButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  disableText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  panel: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    padding: 14,
    gap: 8,
  },
  panelHint: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  qrFrame: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    padding: 8,
    borderRadius: 6,
  },
  secretText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceHover.hex,
    padding: 8,
    borderRadius: 6,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  panelActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  confirmButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  confirmButtonDisabled: {
    opacity: 0.5,
  },
  confirmButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  codesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    backgroundColor: colors.surfaceHover.hex,
    borderRadius: 6,
    padding: 8,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: colors.ink.hex,
    width: '45%',
  },
  doneButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  doneButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
