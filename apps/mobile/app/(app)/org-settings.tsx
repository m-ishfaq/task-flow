import { useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { DIRECTLY_ASSIGNABLE_ROLES, type Role } from '@taskflow/policy';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { useSession } from '../../src/lib/use-session.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { useStepUp } from '../../src/lib/use-step-up.js';
import { StepUpSheet } from '../../src/lib/step-up-sheet.js';
import {
  ORG_DETAIL_QUERY_KEY,
  MEMBERS_QUERY_KEY,
  type Member,
} from '../../src/lib/org-settings.js';

/**
 * Organization settings — the org itself and its members, ported from
 * `apps/web/src/features/admin/settings-page.tsx`. Same routes, same
 * capability-gated shape: the member roster is `member:read` (every role
 * sees it, matching `channel-details/[channelId].tsx`'s own precedent of
 * showing a full roster and gating only the ACTIONS on top of it), while
 * inviting, changing a role, and removing each check their own
 * `capabilities` flag from `tenancy.orgs.get` — never a role comparison
 * here (CLAUDE.md rule 2; `role === 'admin'` outside `packages/policy` is a
 * lint error this file never triggers).
 *
 * Reached from `(tabs)/account.tsx`'s "Manage organization" link — real,
 * separate work found genuinely not started at all when checked directly
 * against `apps/mobile/app/`'s own route list (a live report: "still
 * project, org settings and perms not wired yet").
 *
 * **Change role and Remove both go through `useStepUp`**, the identical
 * `guard`/retry pattern `sessions-section.tsx` and `connected-accounts-
 * section.tsx` already use — `tenancy.members.changeRole`/`.remove` are
 * both `stepUp: true` server-side (§8.1: role changes are what an attacker
 * holding a stolen session reaches for first), so this is not optional
 * plumbing to add later; the mutation genuinely fails without it. `Add` has
 * no such guard, matching the server route it calls, which carries none.
 *
 * **What this deliberately does NOT port**: Teams (`TeamSection`),
 * billing (`BillingSection`), and ownership transfer
 * (`transferOwnership`'s own dialog) are all real, separate surfaces on
 * web with no comparable urgency behind them — the roster and role
 * changes are what "org settings and perms" was actually asking for. A
 * follow-up, not a silent omission.
 */
export default function OrgSettingsScreen() {
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();
  const currentUserId = useSession((state) => state.userId);
  const { guard, pending, confirm, cancel } = useStepUp();

  const org = useQuery({
    queryKey: ORG_DETAIL_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
  });
  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.members.list.query()),
  });

  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [rolePickerFor, setRolePickerFor] = useState<Member | null>(null);

  const capabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    removeMembers: false,
    manageTeams: false,
    createProject: false,
  };

  const refreshMembers = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
  };

  const rename = useMutation({
    mutationFn: (value: string) => apiClient.tenancy.orgs.update.mutate({ name: value }),
    onSuccess: async () => {
      setName(null);
      await queryClient.invalidateQueries({ queryKey: ORG_DETAIL_QUERY_KEY });
    },
  });

  const add = useMutation({
    mutationFn: (input: { email: string; role: Role }) =>
      apiClient.tenancy.members.add.mutate(input),
    onSuccess: async () => {
      setEmail('');
      await refreshMembers();
    },
  });

  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: Role }) =>
      apiClient.tenancy.members.changeRole.mutate({ userId: input.userId, role: input.role }),
    onSuccess: async () => {
      setRolePickerFor(null);
      await refreshMembers();
    },
  });
  const runChangeRole = (input: { userId: string; role: Role }): void => {
    changeRole.mutate(input, {
      onError: (error) => {
        guard(error, () => {
          runChangeRole(input);
        });
      },
    });
  };

  const remove = useMutation({
    mutationFn: (userId: string) => apiClient.tenancy.members.remove.mutate({ userId: userId }),
    onSuccess: refreshMembers,
  });
  const runRemove = (userId: string): void => {
    remove.mutate(userId, {
      onError: (error) => {
        guard(error, () => {
          runRemove(userId);
        });
      },
    });
  };

  const currentName = name ?? org.data?.name ?? '';

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <Pressable
        style={styles.backButton}
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      <Text style={styles.screenTitle}>Organization settings</Text>

      {org.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : org.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(org.error)?.error.message ?? "Couldn't load this organization."}
        </Text>
      ) : (
        <>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Organization</Text>
            <TextInput
              value={currentName}
              editable={capabilities.updateOrg}
              onChangeText={setName}
              style={styles.formInput}
            />
            <Text style={styles.sectionHint}>Slug {org.data.slug}</Text>
            {capabilities.updateOrg &&
              currentName.trim() !== '' &&
              currentName !== org.data.name && (
                <Pressable
                  style={styles.saveButton}
                  disabled={rename.isPending}
                  onPress={() => {
                    rename.mutate(currentName.trim());
                  }}
                >
                  {rename.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.saveButtonText}>Save</Text>
                  )}
                </Pressable>
              )}
            {rename.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(rename.error)?.error.message ?? 'Could not rename the organization.'}
              </Text>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Members · {members.data?.length ?? 0}</Text>

            {/* A whole form nobody without member:invite could ever submit is
                clutter, not information — the same "hidden rather than
                shown-and-refused" call `channel-details/[channelId].tsx`'s own
                AddMemberControl already makes; the roster below still renders
                fully regardless. */}
            {capabilities.inviteMember && (
              <View style={styles.addForm}>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="colleague@example.com"
                  placeholderTextColor={colors.inkFaint.hex}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={styles.formInput}
                />
                <View style={styles.roleRow}>
                  {DIRECTLY_ASSIGNABLE_ROLES.map((entry) => (
                    <Pressable
                      key={entry}
                      style={[styles.roleChip, inviteRole === entry && styles.roleChipActive]}
                      onPress={() => {
                        setInviteRole(entry);
                      }}
                    >
                      <Text
                        style={[
                          styles.roleChipText,
                          inviteRole === entry && styles.roleChipTextActive,
                        ]}
                      >
                        {entry}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  style={styles.saveButton}
                  disabled={add.isPending || email.trim() === ''}
                  onPress={() => {
                    add.mutate({ email: email.trim(), role: inviteRole });
                  }}
                >
                  {add.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.saveButtonText}>Add member</Text>
                  )}
                </Pressable>
                {add.isError && (
                  <Text style={styles.sectionError} accessibilityRole="alert">
                    {apiErrorOf(add.error)?.error.message ?? 'They could not be added.'}
                  </Text>
                )}
              </View>
            )}

            {members.isPending ? (
              <ActivityIndicator color={colors.accent.hex} />
            ) : members.isError ? (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(members.error)?.error.message ?? "Couldn't load members."}
              </Text>
            ) : (
              members.data.map((member) => (
                <View key={member.userId} style={styles.memberRow}>
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberEmail} numberOfLines={1}>
                      {member.displayName ?? member.email}
                      {member.userId === currentUserId ? ' (you)' : ''}
                    </Text>
                    {member.status !== 'active' && (
                      <Text style={styles.memberStatus}>{member.status}</Text>
                    )}
                  </View>
                  {capabilities.manageMembers ? (
                    <Pressable
                      style={styles.roleBadge}
                      disabled={changeRole.isPending || remove.isPending}
                      onPress={() => {
                        setRolePickerFor(member);
                      }}
                    >
                      <Text style={styles.roleBadgeText}>{member.role}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.roleBadge}>
                      <Text style={styles.roleBadgeText}>{member.role}</Text>
                    </View>
                  )}
                  {capabilities.removeMembers && (
                    <Pressable
                      disabled={changeRole.isPending || remove.isPending}
                      onPress={() => {
                        runRemove(member.userId);
                      }}
                    >
                      <Text style={styles.removeText}>Remove</Text>
                    </Pressable>
                  )}
                </View>
              ))
            )}
            {remove.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(remove.error)?.error.message ?? 'That member could not be removed.'}
              </Text>
            )}
          </View>
        </>
      )}

      <RolePickerModal
        member={rolePickerFor}
        pending={changeRole.isPending}
        onPick={(next) => {
          if (rolePickerFor === null) return;
          runChangeRole({ userId: rolePickerFor.userId, role: next });
        }}
        onClose={() => {
          setRolePickerFor(null);
        }}
      />
      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </ScrollView>
  );
}

/**
 * The CURRENT role is always offered even when it is not directly
 * assignable — an Owner's row would otherwise offer no way to leave the
 * picker without silently reading as "demote to admin," the same
 * reasoning `settings-page.tsx`'s own `MemberRow` documents for its
 * `<select>` deduping `[member.role, ...DIRECTLY_ASSIGNABLE_ROLES]`.
 */
function RolePickerModal({
  member,
  pending,
  onPick,
  onClose,
}: {
  readonly member: Member | null;
  readonly pending: boolean;
  readonly onPick: (role: Role) => void;
  readonly onClose: () => void;
}) {
  const roles =
    member === null ? [] : [...new Set<string>([member.role, ...DIRECTLY_ASSIGNABLE_ROLES])];

  return (
    <Modal visible={member !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>
            Role for {member?.displayName ?? member?.email ?? ''}
          </Text>
          {roles.map((entry) => (
            <Pressable
              key={entry}
              style={styles.modalRow}
              disabled={pending}
              onPress={() => {
                onPick(entry as Role);
              }}
            >
              <Text style={styles.modalRowText}>{entry}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
  },
  saveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  addForm: {
    gap: 8,
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 12,
  },
  roleRow: {
    flexDirection: 'row',
    gap: 6,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  roleChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  roleChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  roleChipTextActive: {
    color: colors.accentInk.hex,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  memberInfo: {
    flex: 1,
    gap: 2,
  },
  memberEmail: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  memberStatus: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning.hex,
  },
  roleBadge: {
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  roleBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  removeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 15,
    color: colors.ink.hex,
    textTransform: 'capitalize',
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
