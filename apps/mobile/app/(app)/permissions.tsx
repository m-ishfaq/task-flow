import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { GRANTABLE_PERMISSIONS } from '@taskflow/policy';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { useStepUp } from '../../src/lib/use-step-up.js';
import { StepUpSheet } from '../../src/lib/step-up-sheet.js';
import { CapabilityGate } from '../../src/lib/capability-gate.js';
import { ScreenHeader } from '../../src/lib/screen-header.js';
import { ErrorView } from '../../src/lib/error-view.js';
import { SkeletonList } from '../../src/lib/skeleton.js';
import { Avatar } from '../../src/lib/avatar.js';
import {
  MEMBERS_QUERY_KEY,
  MEMBER_GRANTS_QUERY_KEY,
  type Member,
  type MemberGrant,
} from '../../src/lib/org-settings.js';

/**
 * Individual permissions — `apps/web/src/features/admin/settings-page.tsx`'s
 * `PermissionsSection`, ported. This existed nowhere on mobile until now:
 * `org-settings.tsx`'s own header named exactly one section it deliberately
 * did not port (Billing, its own screen) and said nothing about this one —
 * it was simply never built, the same "not started at all" gap that
 * screen's own header describes finding for the rest of org settings.
 * Reached from `org-settings.tsx`'s own new "Individual permissions" link,
 * gated the same way that link is: `capabilities.manageMembers`.
 *
 * One org-level permission given to (or taken from) one specific member, on
 * top of their role — e.g. letting one Guest place calls, or one Member
 * manage the webhook registry, without changing anyone's role.
 * `GRANTABLE_PERMISSIONS` is the same closed list the server enforces
 * (`packages/policy`'s `isGrantable`), imported rather than hand-copied.
 *
 * The add sheet is a batch, mirroring web's own evolution away from
 * one-pair-per-submission: both the member list and the permission list are
 * multi-select, and submitting grants the full Cartesian product in one
 * action. `runGrantBatch` still calls the existing single-pair
 * `memberGrants.grant` route in sequence — there is no bulk route — which is
 * safe only because that route is idempotent (granting something already
 * granted returns the existing row), so a batch that fails partway through
 * a step-up prompt is retried from the start in full, and every pair before
 * the failure point silently no-ops on the retry.
 *
 * The list below is grouped one CARD per person, each grant a chip with its
 * own revoke × — Design Bible §15's own "PERMISSIONS — WHAT WAS WRONG"
 * finding, fixed as it names: "each (person × permission) was its own row —
 * Rosa Pereira appeared 4 times for 4 grants, four identical name/role
 * rows. Grouped to one card per person... the exact fix web already
 * shipped, now matched on mobile." Revoking is still one grant at a time;
 * unlike granting, there was no reported need yet for a bulk-revoke sheet.
 */
export default function PermissionsScreen(): React.JSX.Element | null {
  return (
    <CapabilityGate capability="manageMembers">
      <PermissionsScreenContent />
    </CapabilityGate>
  );
}

function PermissionsScreenContent() {
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();
  const { guard, pending, confirm, cancel } = useStepUp();

  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.members.list.query()),
  });
  const grants = useQuery({
    queryKey: MEMBER_GRANTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.memberGrants.list.query()),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [pickedUserIds, setPickedUserIds] = useState<ReadonlySet<string>>(new Set());
  const [pickedPermissions, setPickedPermissions] = useState<ReadonlySet<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: MEMBER_GRANTS_QUERY_KEY });

  const runGrantBatch = async (
    pairs: readonly { readonly userId: string; readonly permission: string }[],
  ): Promise<void> => {
    for (const pair of pairs) {
      await apiClient.tenancy.memberGrants.grant.mutate(pair);
    }
  };

  const bulkGrant = useMutation({
    mutationFn: runGrantBatch,
    onSuccess: async () => {
      setAddOpen(false);
      setPickedUserIds(new Set());
      setPickedPermissions(new Set());
      setMemberQuery('');
      await refresh();
    },
  });
  const runGrant = (pairs: readonly { readonly userId: string; readonly permission: string }[]) => {
    bulkGrant.mutate(pairs, {
      onError: (error) => {
        guard(error, () => {
          runGrant(pairs);
        });
      },
    });
  };

  const revoke = useMutation({
    mutationFn: (input: { userId: string; permission: string }) =>
      apiClient.tenancy.memberGrants.revoke.mutate(input),
    onSuccess: refresh,
  });
  const runRevoke = (input: { userId: string; permission: string }) => {
    revoke.mutate(input, {
      onError: (error) => {
        guard(error, () => {
          runRevoke(input);
        });
      },
    });
  };

  const toggleUser = (userId: string) => {
    setPickedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };
  const togglePermission = (value: string) => {
    setPickedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const memberById = new Map((members.data ?? []).map((member) => [member.userId, member]));
  const labelOf = (member: { readonly email: string; readonly displayName: string | null }) =>
    member.displayName ?? member.email;

  const needle = memberQuery.trim().toLowerCase();
  const matches = (members.data ?? []).filter(
    (member) =>
      needle === '' ||
      member.email.toLowerCase().includes(needle) ||
      (member.displayName?.toLowerCase().includes(needle) ?? false),
  );

  const submitCount = pickedUserIds.size * pickedPermissions.size;
  const permissions = [...GRANTABLE_PERMISSIONS];

  // Design Bible §15: one card per person, not one row per grant.
  const grantsByUser = new Map<string, MemberGrant[]>();
  for (const entry of grants.data ?? []) {
    const existing = grantsByUser.get(entry.userId);
    if (existing) existing.push(entry);
    else grantsByUser.set(entry.userId, [entry]);
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      <ScreenHeader
        title="Individual permissions"
        subtitle="On top of a member's role, one specific ability can be given to (or taken from) one person."
      />
      {/* `+ Add` moved below the header, its own row — the same fix
          `org-settings.tsx` applies for "Billing"/"Transfer ownership":
          `ScreenHeader` has no trailing-action slot, so nothing here can
          collide with `top-bar.tsx`'s persistent icon cluster again. */}
      <Pressable
        style={styles.addButton}
        onPress={() => {
          setAddOpen(true);
        }}
      >
        <Text style={styles.addButtonText}>+ Add</Text>
      </Pressable>

      {(members.isPending || grants.isPending) && <SkeletonList count={3} />}
      {grants.isError && (
        <ErrorView message={apiErrorOf(grants.error)?.error.message ?? "Couldn't load grants."} />
      )}

      {grants.isSuccess && grants.data.length === 0 && (
        <Text style={styles.emptyHint}>No individual grants yet. Tap + Add to create one.</Text>
      )}

      <ScrollView contentContainerStyle={styles.list}>
        {[...grantsByUser.entries()].map(([userId, entries]) => {
          const member = memberById.get(userId);
          const label = member ? labelOf(member) : userId;
          return (
            <View key={userId} style={styles.personCard}>
              <View style={styles.personCardHeader}>
                <Avatar label={label} size={32} seed={userId} />
                <View style={styles.personCardHeaderText}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {label}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {member?.role ?? 'former member'}
                  </Text>
                </View>
              </View>
              <View style={styles.chipsRow}>
                {entries.map((entry) => (
                  <View key={entry.permission} style={styles.permissionChip}>
                    <Text style={styles.permissionChipText} numberOfLines={1}>
                      {entry.permission}
                    </Text>
                    <Pressable
                      hitSlop={8}
                      disabled={revoke.isPending}
                      onPress={() => {
                        runRevoke({ userId: entry.userId, permission: entry.permission });
                      }}
                    >
                      <Text style={styles.permissionChipRemove}>✕</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <Modal
        visible={addOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setAddOpen(false);
        }}
      >
        <KeyboardAvoidingView
          style={styles.avoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setAddOpen(false);
            }}
          >
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>Grant permissions</Text>

              <Text style={styles.modalSectionLabel}>Members</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="Search by name or email…"
                placeholderTextColor={colors.inkFaint.hex}
                value={memberQuery}
                onChangeText={setMemberQuery}
              />
              <ScrollView style={styles.modalPickerList}>
                {matches.map((member: Member) => (
                  <Pressable
                    key={member.userId}
                    style={styles.modalPickerRow}
                    onPress={() => {
                      toggleUser(member.userId);
                    }}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        pickedUserIds.has(member.userId) && styles.checkboxChecked,
                      ]}
                    />
                    <Text style={styles.modalPickerRowText} numberOfLines={1}>
                      {labelOf(member)}
                    </Text>
                    <Text style={styles.modalPickerRowRole}>{member.role}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              {pickedUserIds.size > 0 && (
                <Text style={styles.selectionSummary}>
                  {pickedUserIds.size} member{pickedUserIds.size === 1 ? '' : 's'} selected
                </Text>
              )}

              <Text style={styles.modalSectionLabel}>Permissions</Text>
              <ScrollView style={styles.modalPickerList}>
                {permissions.map((entry) => (
                  <Pressable
                    key={entry}
                    style={styles.modalPickerRow}
                    onPress={() => {
                      togglePermission(entry);
                    }}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        pickedPermissions.has(entry) && styles.checkboxChecked,
                      ]}
                    />
                    <Text style={styles.modalPickerRowText} numberOfLines={1}>
                      {entry}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              {pickedPermissions.size > 0 && (
                <Text style={styles.selectionSummary}>
                  {pickedPermissions.size} permission{pickedPermissions.size === 1 ? '' : 's'}{' '}
                  selected
                </Text>
              )}

              {bulkGrant.isError && (
                <Text style={styles.errorText}>
                  {apiErrorOf(bulkGrant.error)?.error.message ?? 'Those grants could not be saved.'}
                </Text>
              )}

              <View style={styles.modalActions}>
                <Pressable
                  style={[
                    styles.modalPrimaryButton,
                    (bulkGrant.isPending || submitCount === 0) && styles.buttonDisabled,
                  ]}
                  disabled={bulkGrant.isPending || submitCount === 0}
                  onPress={() => {
                    const pairs: { userId: string; permission: string }[] = [];
                    for (const userId of pickedUserIds) {
                      for (const permission of pickedPermissions) {
                        pairs.push({ userId, permission });
                      }
                    }
                    runGrant(pairs);
                  }}
                >
                  {bulkGrant.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.modalPrimaryButtonText}>
                      {submitCount > 1 ? `Grant (${String(submitCount)})` : 'Grant'}
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    setAddOpen(false);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
    paddingHorizontal: 24,
  },
  addButton: {
    alignSelf: 'flex-start',
    marginBottom: 8,
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  addButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyHint: {
    marginTop: 16,
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  list: {
    paddingTop: 4,
    paddingBottom: 40,
    gap: 10,
  },
  personCard: {
    gap: 10,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    padding: 12,
  },
  personCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  personCardHeaderText: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowMeta: {
    fontSize: 11,
    color: colors.inkFaint.hex,
    marginTop: 1,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  permissionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: 200,
  },
  permissionChipText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: colors.ink.hex,
  },
  permissionChipRemove: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.danger.hex,
  },
  avoider: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    maxHeight: '85%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 10,
  },
  modalSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    marginTop: 10,
    marginBottom: 4,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  modalPickerList: {
    maxHeight: 140,
    marginTop: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
  },
  modalPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalPickerRowText: {
    flex: 1,
    fontSize: 13,
    color: colors.ink.hex,
  },
  modalPickerRowRole: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.line.hex,
  },
  checkboxChecked: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  selectionSummary: {
    marginTop: 4,
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  errorText: {
    marginTop: 10,
    fontSize: 12,
    color: colors.danger.hex,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  modalPrimaryButton: {
    flex: 1,
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 11,
    alignItems: 'center',
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  modalSecondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  modalSecondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
