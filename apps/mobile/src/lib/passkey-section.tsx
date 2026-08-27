import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatDistanceToNow } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire, type Wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useStepUp } from './use-step-up.js';
import { StepUpSheet } from './step-up-sheet.js';
import { loadPasskeys, toRegistrationResponse, type PasskeyCreationResult } from './passkeys.js';
import type { MobileTRPCClient } from './trpc-client.js';

const PASSKEYS_QUERY_KEY = ['auth.passkeys.list'] as const;

type Passkey = Wire<
  Awaited<ReturnType<MobileTRPCClient['auth']['passkeys']['list']['query']>>
>[number];

/**
 * Passkey enrollment, listing, rename, and removal — `apps/web`'s
 * `passkey-section.tsx`, ported. Replaces `(tabs)/account.tsx`'s original
 * enroll-only block, which had no way to see, rename, or remove a passkey
 * once added.
 *
 * `remove` is `stepUp: true` server-side, for the identical reason it is on
 * web (§8.1: removing an authenticator is what a stolen session is used
 * for first, and unlike a password change it leaves no trace until the
 * real owner's next sign-in). `list` and `rename` are not — reading your
 * own roster and relabelling an entry are not credential-adjacent the way
 * adding or removing one is.
 */
export function PasskeySection() {
  const queryClient = useQueryClient();
  const { guard, pending, confirm, cancel } = useStepUp();
  const [passkeySupported, setPasskeySupported] = useState(false);

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

  const passkeys = useQuery({
    queryKey: PASSKEYS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.auth.passkeys.list.query()),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
  };

  const enroll = useMutation({
    mutationFn: async () => {
      const options = await apiClient.auth.passkeys.startRegistration.mutate();
      const { create } = await loadPasskeys();
      const result = await create(options as never);
      if (result === null) return null;
      // See sign-in.tsx's/account.tsx's identical cast for why.
      const response = toRegistrationResponse(result as unknown as PasskeyCreationResult);
      return apiClient.auth.passkeys.finishRegistration.mutate({ response: response as never });
    },
    onSuccess: refresh,
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      apiClient.auth.passkeys.rename.mutate(input),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiClient.auth.passkeys.remove.mutate({ id }),
    onSuccess: refresh,
  });
  const runRemove = (id: string): void => {
    remove.mutate(id, {
      onError: (error) => {
        guard(error, () => {
          runRemove(id);
        });
      },
    });
  };

  if (!passkeySupported && (passkeys.data ?? []).length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Passkeys</Text>
      <Text style={styles.sectionHint}>
        Sign in without a password. A passkey belongs to this device, not to any one organization.
      </Text>

      {passkeySupported && (
        <>
          <Pressable
            style={styles.enrollButton}
            disabled={enroll.isPending}
            onPress={() => {
              enroll.mutate();
            }}
          >
            {enroll.isPending ? (
              <ActivityIndicator color={colors.ink.hex} />
            ) : (
              <Text style={styles.enrollButtonText}>Add a passkey to this device</Text>
            )}
          </Pressable>
          {enroll.isError && (
            <Text style={styles.sectionError} accessibilityRole="alert">
              {apiErrorOf(enroll.error)?.error.message ?? 'Could not add a passkey.'}
            </Text>
          )}
        </>
      )}

      {(passkeys.data ?? []).map((passkey) => (
        <PasskeyRow
          key={passkey.id}
          passkey={passkey}
          busy={rename.isPending || remove.isPending}
          onRename={(name) => {
            rename.mutate({ id: passkey.id, name });
          }}
          onRemove={() => {
            runRemove(passkey.id);
          }}
        />
      ))}

      {(rename.isError || remove.isError) && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(rename.error ?? remove.error)?.error.message ??
            'That could not be completed.'}
        </Text>
      )}

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </View>
  );
}

function PasskeyRow({
  passkey,
  busy,
  onRename,
  onRemove,
}: {
  readonly passkey: Passkey;
  readonly busy: boolean;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(passkey.name ?? '');

  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Passkey name"
              placeholderTextColor={colors.inkFaint.hex}
              style={styles.editInput}
              maxLength={64}
              autoFocus
            />
            <Pressable
              disabled={busy || draft.trim() === ''}
              onPress={() => {
                if (draft.trim() !== '') {
                  onRename(draft.trim());
                  setEditing(false);
                }
              }}
            >
              <Text style={styles.rowAction}>Save</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraft(passkey.name ?? '');
                setEditing(false);
              }}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.rowLabel} numberOfLines={1}>
            {passkey.name ?? 'Unnamed passkey'}
          </Text>
        )}
        <Text style={styles.rowMeta}>
          {passkey.deviceType === 'multiDevice' ? 'Syncs across devices' : 'This device only'}
          {passkey.backedUp ? ' · backed up' : ''} · added{' '}
          {formatDistanceToNow(new Date(passkey.createdAt), { addSuffix: true })}
        </Text>
      </View>

      {!editing && (
        <View style={styles.rowActions}>
          <Pressable
            disabled={busy}
            onPress={() => {
              setEditing(true);
            }}
          >
            <Text style={styles.rowAction}>Rename</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onRemove}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </View>
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
  enrollButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  enrollButtonText: {
    color: colors.ink.hex,
    fontSize: 15,
    fontWeight: '600',
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
  rowLabel: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowMeta: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 12,
  },
  rowAction: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  removeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  editInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
