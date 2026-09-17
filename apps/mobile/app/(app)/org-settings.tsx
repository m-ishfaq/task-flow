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
  TEAMS_QUERY_KEY,
  type Member,
  type Team,
} from '../../src/lib/org-settings.js';
import { CapabilityGate } from '../../src/lib/capability-gate.js';

/**
 * Organization settings — the org itself, its members, and its teams,
 * ported from `apps/web/src/features/admin/settings-page.tsx`. Same
 * routes, same capability-gated shape: the member and team ROSTERS are
 * `member:read`/`team:read` — every role EXCEPT Guest sees them by role
 * alone (`packages/policy/src/roles.ts`'s empty `GUEST` list; this header
 * used to say "every role," which was wrong the moment a Guest could reach
 * this screen at all), matching `channel-details/[channelId].tsx`'s own
 * precedent of showing a full roster and gating only the ACTIONS on top of
 * it, for every role that CAN see the roster in the first place. Inviting,
 * changing a role, removing, transferring ownership, creating a team, and
 * managing its members each check their own `capabilities` flag from
 * `tenancy.orgs.get` — never a role comparison here (CLAUDE.md rule 2;
 * `role === 'admin'` outside `packages/policy` is a lint error this file
 * never triggers).
 *
 * The default export wraps the real screen in
 * `CapabilityGate capability="viewDirectory"` — found from a real report: a
 * Guest reaches this screen via `account.tsx`'s "Manage organization" link,
 * which is deliberately always shown (nothing on THIS screen needs gating
 * at the link level, since every non-Guest role sees at least the org's own
 * name), and every non-Guest role has always been able to see a member
 * roster here. `viewDirectory` is exactly the boolean that already answers
 * "can this caller reach `tenancy.members.list`/`tenancy.orgs.get`'s member
 * data at all" — reusing it here is the identical fix `people.tsx` already
 * makes for the org directory, applied to the second place a Guest could
 * reach the same raw FORBIDDEN.
 *
 * Reached from `account.tsx`'s "Manage organization" link (that screen
 * itself now a pushed sibling of this one under `(app)/`, not a tab — see
 * `top-bar.tsx`'s header) — real, separate work found genuinely not
 * started at all when checked directly against `apps/mobile/app/`'s own
 * route list (a live report: "still project, org settings and perms not
 * wired yet").
 *
 * **Change role, Remove, and Transfer ownership all go through
 * `useStepUp`**, the identical `guard`/retry pattern `sessions-section.tsx`
 * and `connected-accounts-section.tsx` already use — the three routes are
 * `stepUp: true` server-side (§8.1: role changes are what an attacker
 * holding a stolen session reaches for first), so this is not optional
 * plumbing to add later; the mutation genuinely fails without it. `Add`,
 * team `create`, and team `addMember`/`removeMember` carry no such guard,
 * matching the server routes they call, none of which do either.
 *
 * **"Transfer ownership…" is gated on `capabilities.manageMembers`, same
 * as changing a role** — ownership has exactly one holder, so the button
 * is never usable by anyone but the current Owner, not "usually not,
 * never." The candidate list is every member except the caller,
 * deliberately unfiltered by role: filtering it here would be the UI
 * re-deriving authorization, which is exactly what §8.2 forbids — the
 * server refuses a guest jumping straight to Owner and the route answers
 * FORBIDDEN for anyone but the Owner regardless of what this screen shows.
 *
 * **What this deliberately does NOT port**: billing (`BillingSection`) is
 * a real, separate surface — see `billing.tsx`'s own header for why it is
 * a whole screen rather than a section appended here. Individual
 * permissions (`PermissionsSection`) is the same shape — its own screen,
 * `permissions.tsx`, reached from the link below — but for a different
 * reason: it isn't a distinct PRODUCT surface the way billing is, it is
 * simply large enough (a multi-select member picker, a multi-select
 * permission picker, a batch-grant sheet, a revocable list) that folding it
 * into this already-1000-line screen would make both worse. This was a real
 * gap until this pass, not a deliberate omission — mobile had no way to
 * grant or revoke an individual permission at all, web-only, which mattered
 * more once Wave 2 made the automation permissions individually grantable
 * too and an org running mobile-only had no way to hand one out.
 */
export default function OrgSettingsScreen(): React.JSX.Element {
  return (
    <CapabilityGate capability="viewDirectory">
      <OrgSettingsScreenContent />
    </CapabilityGate>
  );
}

function OrgSettingsScreenContent() {
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
  const teams = useQuery({
    queryKey: TEAMS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.teams.list.query()),
  });

  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [rolePickerFor, setRolePickerFor] = useState<Member | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const capabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    removeMembers: false,
    manageTeams: false,
    createProject: false,
    viewAnalytics: false,
    viewAuditLog: false,
    readPhoneNumbers: false,
    placeCalls: false,
    readCalls: false,
    sendSms: false,
    readSms: false,
    manageAutomations: false,
    manageWebhooks: false,
    manageIntegrations: false,
    createApiTokens: false,
    revokeApiTokens: false,
    viewBilling: false,
    purchaseNumbers: false,
    releaseNumbers: false,
    manageSavedSearches: false,
    readRecordings: false,
    createSpace: false,
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

  /**
   * Email invitations (migration 0107) — the door `members.add` was never
   * built to cover, the identical swap `settings-page.tsx`'s own
   * `MemberSection` makes on web. Always sends mail, whether or not the
   * address already has a Rinavai account. No pending-invitations list or
   * resend/revoke here yet — a real, narrower scope than web's for this
   * pass, not a parity gap this screen was built to ignore.
   */
  const add = useMutation({
    mutationFn: (input: { email: string; role: Role }) =>
      apiClient.tenancy.invitations.send.mutate(input),
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

  const transfer = useMutation({
    mutationFn: (input: { toUserId: string; selfNewRole: 'admin' | 'member' }) =>
      apiClient.tenancy.members.transferOwnership.mutate(input),
    onSuccess: async () => {
      setTransferOpen(false);
      await refreshMembers();
    },
  });
  const runTransfer = (input: { toUserId: string; selfNewRole: 'admin' | 'member' }): void => {
    transfer.mutate(input, {
      onError: (error) => {
        guard(error, () => {
          runTransfer(input);
        });
      },
    });
  };
  const transferCandidates = (members.data ?? []).filter(
    (member) => member.userId !== currentUserId,
  );

  const refreshTeams = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY });
  };

  const createTeam = useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      apiClient.tenancy.teams.create.mutate(input),
    onSuccess: refreshTeams,
  });

  const addTeamMember = useMutation({
    mutationFn: (input: { teamId: string; userId: string }) =>
      apiClient.tenancy.teams.addMember.mutate(input),
    onSuccess: refreshTeams,
  });

  const removeTeamMember = useMutation({
    mutationFn: (input: { teamId: string; userId: string }) =>
      apiClient.tenancy.teams.removeMember.mutate(input),
    onSuccess: refreshTeams,
  });

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
      <View style={styles.titleRow}>
        <Text style={styles.screenTitle}>Organization settings</Text>
        {/* `org:billing` is Owner-only and nothing ever turns it on for
            anyone else (no tuple, no plan upgrade, no member grant) — see
            `billing.tsx`'s own header, updated alongside this one (Phase 15
            §1's audit of the old "render unconditionally, let it 403"
            doctrine). Hidden entirely rather than shown-and-refused: a
            non-owner tapping this would only ever see their own org's
            billing configuration answer FORBIDDEN, never anything useful. */}
        {capabilities.viewBilling && (
          <Pressable
            style={styles.billingLink}
            onPress={() => {
              router.push('/billing');
            }}
          >
            <Text style={styles.billingLinkText}>Billing</Text>
          </Pressable>
        )}
      </View>

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
                    <Text style={styles.saveButtonText}>Send invitation</Text>
                  )}
                </Pressable>
                {add.isError && (
                  <Text style={styles.sectionError} accessibilityRole="alert">
                    {apiErrorOf(add.error)?.error.message ?? 'The invitation could not be sent.'}
                  </Text>
                )}
              </View>
            )}

            {/* Never usable by anyone but the current Owner, not "usually not" —
                ownership has exactly one holder. The server (`member:manage`)
                is still what actually enforces it; this only stops offering the
                action to everyone who structurally cannot take it. */}
            {capabilities.manageMembers && (
              <Pressable
                style={styles.transferLink}
                disabled={transferCandidates.length === 0}
                onPress={() => {
                  setTransferOpen(true);
                }}
              >
                <Text
                  style={[
                    styles.transferLinkText,
                    transferCandidates.length === 0 && styles.transferLinkTextDisabled,
                  ]}
                >
                  Transfer ownership…
                </Text>
              </Pressable>
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

          {/* `permissions.tsx` — its own screen, ported from web's
              `PermissionsSection` (Phase 15 §1). Hidden entirely for anyone
              without `member:manage`, the same reasoning `transferLink`
              above already follows: seeing this link would mean seeing
              which colleague holds which individual permission, which is
              administrative information about other people, not something
              "you can see the Members list" implies on its own. */}
          {capabilities.manageMembers && (
            <View style={styles.section}>
              <Pressable
                style={styles.transferLink}
                onPress={() => {
                  router.push('/permissions');
                }}
              >
                <Text style={styles.transferLinkText}>Individual permissions…</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Teams · {teams.data?.length ?? 0}</Text>
            <Text style={styles.sectionHint}>
              A team is a subject a grant can name. Adding someone to a team gives them everything
              that team has been granted, immediately.
            </Text>

            {capabilities.manageTeams && (
              <NewTeamForm
                pending={createTeam.isPending}
                onCreate={(teamName) => {
                  createTeam.mutate({ name: teamName, slug: slugifyTeamName(teamName) });
                }}
              />
            )}
            {createTeam.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(createTeam.error)?.error.message ?? 'Could not create this team.'}
              </Text>
            )}

            {teams.isPending ? (
              <ActivityIndicator color={colors.accent.hex} />
            ) : teams.isError ? (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(teams.error)?.error.message ?? "Couldn't load teams."}
              </Text>
            ) : teams.data.length === 0 ? (
              <Text style={styles.emptyHint}>No teams yet.</Text>
            ) : (
              teams.data.map((team) => (
                <TeamCard
                  key={team.teamId}
                  team={team}
                  orgMembers={members.data ?? []}
                  canManage={capabilities.manageTeams}
                  busy={addTeamMember.isPending || removeTeamMember.isPending}
                  onAdd={(userId) => {
                    addTeamMember.mutate({ teamId: team.teamId, userId });
                  }}
                  onRemove={(userId) => {
                    removeTeamMember.mutate({ teamId: team.teamId, userId });
                  }}
                />
              ))
            )}
            {addTeamMember.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(addTeamMember.error)?.error.message ?? 'Could not add that member.'}
              </Text>
            )}
            {removeTeamMember.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(removeTeamMember.error)?.error.message ??
                  'Could not remove that member.'}
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
      <TransferOwnershipModal
        visible={transferOpen}
        candidates={transferCandidates}
        pending={transfer.isPending}
        onTransfer={(input) => {
          runTransfer(input);
        }}
        onClose={() => {
          setTransferOpen(false);
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

/**
 * Names the new owner AND the caller's resulting role, because the
 * transaction changes both rows at once — there is never an observable
 * zero-owner moment in between, matching `settings-page.tsx`'s own dialog.
 */
function TransferOwnershipModal({
  visible,
  candidates,
  pending,
  onTransfer,
  onClose,
}: {
  readonly visible: boolean;
  readonly candidates: readonly Member[];
  readonly pending: boolean;
  readonly onTransfer: (input: { toUserId: string; selfNewRole: 'admin' | 'member' }) => void;
  readonly onClose: () => void;
}) {
  const [selfNewRole, setSelfNewRole] = useState<'admin' | 'member'>('admin');
  const [transferSearch, setTransferSearch] = useState('');

  const filteredCandidates = candidates.filter((member) => {
    if (transferSearch.trim() === '') return true;
    const q = transferSearch.toLowerCase();
    return (
      (member.displayName ?? '').toLowerCase().includes(q) || member.email.toLowerCase().includes(q)
    );
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Transfer ownership</Text>
          <Text style={styles.sectionHint}>
            The new owner gets everything Owner allows, immediately. You become {selfNewRole} in the
            same transaction — there is never a moment with no owner.
          </Text>

          <Text style={[styles.sectionTitle, styles.modalSubTitle]}>Your role afterwards</Text>
          <View style={styles.roleRow}>
            {(['admin', 'member'] as const).map((entry) => (
              <Pressable
                key={entry}
                style={[styles.roleChip, selfNewRole === entry && styles.roleChipActive]}
                onPress={() => {
                  setSelfNewRole(entry);
                }}
              >
                <Text
                  style={[styles.roleChipText, selfNewRole === entry && styles.roleChipTextActive]}
                >
                  {entry}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.sectionTitle, styles.modalSubTitle]}>New owner</Text>
          {candidates.length === 0 ? (
            <Text style={styles.emptyHint}>There is nobody else to transfer to yet.</Text>
          ) : (
            <>
              <TextInput
                style={styles.pickerSearch}
                placeholder="Search members…"
                placeholderTextColor={colors.inkFaint.hex}
                value={transferSearch}
                onChangeText={setTransferSearch}
                autoCorrect={false}
              />
              <ScrollView style={styles.pickerScroll} nestedScrollEnabled>
                {filteredCandidates.length === 0 ? (
                  <Text style={styles.emptyHint}>No matches.</Text>
                ) : (
                  filteredCandidates.map((member) => (
                    <Pressable
                      key={member.userId}
                      style={styles.modalRow}
                      disabled={pending}
                      onPress={() => {
                        onTransfer({ toUserId: member.userId, selfNewRole });
                      }}
                    >
                      <Text style={styles.modalRowText}>
                        {member.displayName ?? member.email} ({member.role})
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </>
          )}
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function NewTeamForm({
  pending,
  onCreate,
}: {
  readonly pending: boolean;
  readonly onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <View style={styles.addForm}>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Engineering"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
      />
      <Text style={styles.sectionHint}>
        {name.trim() === ''
          ? 'The address is derived from the name and must be unique.'
          : `Address: ${slugifyTeamName(name)}`}
      </Text>
      <Pressable
        style={styles.saveButton}
        disabled={pending || name.trim() === ''}
        onPress={() => {
          onCreate(name.trim());
          setName('');
        }}
      >
        {pending ? (
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.saveButtonText}>Create team</Text>
        )}
      </Pressable>
    </View>
  );
}

/**
 * One team with its roster — mirrors `settings-page.tsx`'s own `TeamCard`:
 * membership shown as the thing it is, a list of people, with each removal
 * on the row of the person being removed, and an add picker offering only
 * candidates NOT already on the team (an empty picker is a fact worth
 * rendering — "everyone is already here" — not a control that silently
 * does nothing).
 */
function TeamCard({
  team,
  orgMembers,
  canManage,
  busy,
  onAdd,
  onRemove,
}: {
  readonly team: Team;
  readonly orgMembers: readonly Member[];
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onAdd: (userId: string) => void;
  readonly onRemove: (userId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const onTeam = new Set(team.members.map((member) => member.userId));
  const candidates = orgMembers.filter((member) => !onTeam.has(member.userId));
  const filteredCandidates = candidates.filter((member) => {
    if (memberSearch.trim() === '') return true;
    const q = memberSearch.toLowerCase();
    return (
      (member.displayName ?? '').toLowerCase().includes(q) || member.email.toLowerCase().includes(q)
    );
  });

  const MAX_AVATARS = 5;
  const visibleMembers = team.members.slice(0, MAX_AVATARS);
  const overflow = team.members.length - MAX_AVATARS;

  return (
    <View style={styles.teamCard}>
      <View style={styles.teamCardHeader}>
        <View style={styles.teamAvatarStack}>
          {visibleMembers.map((member, i) => {
            const initials = (member.email[0] ?? '?').toUpperCase();
            return (
              <View
                key={member.userId}
                style={[styles.teamAvatar, { marginLeft: i === 0 ? 0 : -8 }]}
              >
                <Text style={styles.teamAvatarText}>{initials}</Text>
              </View>
            );
          })}
          {overflow > 0 && (
            <View style={[styles.teamAvatar, styles.teamAvatarOverflow, { marginLeft: -8 }]}>
              <Text style={styles.teamAvatarOverflowText}>+{overflow}</Text>
            </View>
          )}
        </View>
        <View style={styles.teamCardInfo}>
          <Text style={styles.teamCardName} numberOfLines={1}>
            {team.name}
          </Text>
          <Text style={styles.teamCardMeta}>
            {team.members.length === 0
              ? 'No members'
              : `${String(team.members.length)} ${team.members.length === 1 ? 'member' : 'members'}`}
            {' · '}
            <Text style={styles.teamCardSlug}>{team.slug}</Text>
          </Text>
        </View>
        {canManage && !picking && (
          <Pressable
            style={styles.teamAddButton}
            onPress={() => {
              setPicking(true);
            }}
          >
            <Text style={styles.teamAddButtonText}>+ Add</Text>
          </Pressable>
        )}
      </View>

      {team.members.length > 0 && (
        <View style={styles.teamMemberList}>
          {team.members.map((member) => (
            <View key={member.userId} style={styles.teamMemberRow}>
              <View style={styles.teamMemberAvatar}>
                <Text style={styles.teamMemberAvatarText}>
                  {(member.email[0] ?? '?').toUpperCase()}
                </Text>
              </View>
              <Text style={styles.teamMemberEmail} numberOfLines={1}>
                {member.email}
              </Text>
              {canManage && (
                <Pressable
                  disabled={busy}
                  hitSlop={10}
                  onPress={() => {
                    onRemove(member.userId);
                  }}
                >
                  <Text style={styles.teamChipRemove}>✕</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}

      {canManage && picking && (
        <View style={styles.teamPickerContainer}>
          {candidates.length === 0 ? (
            <Text style={styles.emptyHint}>Everyone in the organization is on this team.</Text>
          ) : (
            <>
              <TextInput
                style={styles.pickerSearch}
                placeholder="Search members…"
                placeholderTextColor={colors.inkFaint.hex}
                value={memberSearch}
                onChangeText={setMemberSearch}
                autoFocus
                autoCorrect={false}
              />
              <ScrollView style={styles.pickerScroll} nestedScrollEnabled>
                {filteredCandidates.length === 0 ? (
                  <Text style={styles.emptyHint}>No matches.</Text>
                ) : (
                  filteredCandidates.map((member) => (
                    <Pressable
                      key={member.userId}
                      style={styles.modalRow}
                      disabled={busy}
                      onPress={() => {
                        onAdd(member.userId);
                        setPicking(false);
                        setMemberSearch('');
                      }}
                    >
                      <View style={styles.teamMemberAvatar}>
                        <Text style={styles.teamMemberAvatarText}>
                          {(member.email[0] ?? '?').toUpperCase()}
                        </Text>
                      </View>
                      <Text style={styles.modalRowText}>{member.displayName ?? member.email}</Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
              <Pressable
                style={styles.transferLink}
                onPress={() => {
                  setPicking(false);
                  setMemberSearch('');
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

/** Ported verbatim from `settings-page.tsx`'s own `slugify` — the address is derived, not typed. */
function slugifyTeamName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  billingLink: {
    borderWidth: 1,
    borderColor: colors.accent.hex + '30',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.accent.hex + '08',
  },
  billingLinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingVertical: 6,
  },
  transferLink: {
    alignSelf: 'flex-end',
    paddingVertical: 4,
  },
  transferLinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  transferLinkTextDisabled: {
    color: colors.inkFaint.hex,
  },
  teamCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
    gap: 10,
  },
  teamCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  teamAvatarStack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  teamAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent.hex + '30',
    borderWidth: 2,
    borderColor: colors.surfaceRaised.hex,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  teamAvatarOverflow: {
    backgroundColor: colors.line.hex,
  },
  teamAvatarOverflowText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.inkMuted.hex,
  },
  teamCardInfo: {
    flex: 1,
    gap: 2,
  },
  teamCardName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  teamCardMeta: {
    fontSize: 11,
    color: colors.inkMuted.hex,
  },
  teamCardSlug: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.inkFaint.hex,
  },
  teamAddButton: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.accent.hex + '18',
    borderWidth: 1,
    borderColor: colors.accent.hex + '40',
  },
  teamAddButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  teamMemberList: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
  },
  teamMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
  },
  teamMemberAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent.hex + '20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamMemberAvatarText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  teamMemberEmail: {
    flex: 1,
    fontSize: 13,
    color: colors.ink.hex,
  },
  teamPickerContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
    gap: 4,
  },
  pickerSearch: {
    fontSize: 13,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  pickerScroll: {
    maxHeight: 180,
  },
  rowCount: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  teamChipRemove: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  modalSubTitle: {
    marginTop: 8,
  },
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex + '60',
    paddingTop: 14,
    paddingBottom: 4,
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
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
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
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
  },
  roleRow: {
    flexDirection: 'row',
    gap: 6,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
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
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 12,
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
