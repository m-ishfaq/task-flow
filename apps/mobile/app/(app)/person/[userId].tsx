import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SkeletonList } from '../../../src/lib/skeleton.js';
import { shadows } from '../../../src/lib/premium.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isPast } from 'date-fns';
import { UserIdSchema } from '@taskflow/contracts';
import { parseNullableInstant, wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { TelephonyCallButton } from '../../../src/lib/telephony-call-button.js';
import {
  DIRECTORY_PICKER_QUERY_KEY,
  DIRECTORY_QUERY_KEY,
  directoryLabel,
  directoryMemberQueryKey,
  type DirectoryDetail,
  type ResolvedMember,
} from '../../../src/lib/people.js';
import { PHONE_CONTACTS_QUERY_KEY } from '../../../src/lib/telephony.js';
import { ORG_DETAIL_QUERY_KEY } from '../../../src/lib/org-settings.js';
import { CapabilityGate } from '../../../src/lib/capability-gate.js';

/**
 * One person in the org — `apps/web/src/features/people/person-page.tsx`'s
 * counterpart, reached by tapping a row on the People tab or a name in
 * this screen's own org-chart cards. A sibling of `card/[cardId].tsx`
 * under `(app)/`, not nested in `(tabs)` — `(app)/_layout.tsx`'s own
 * `<Stack>` auto-registers it, no layout change needed to add this file.
 *
 * The org chart (who they report to, who reports to them), the job facts
 * a directory carries, out-of-office state, and — only when viewing
 * someone ELSE — either the admin-edit form (job title/department/work
 * phone/manager, `capabilities.manageMembers`) or, for anyone without that
 * capability, `PersonFactsSummary`: the same four fields, read-only.
 * Matching web's own `PersonFactsSummary` (`person-page.tsx`) rather than
 * hiding the section outright — job title and department are already
 * visible as badges in the "Job" section above and the manager is already
 * reachable via the "Reports to" card, so nothing new is disclosed by
 * presenting them here too, just without edit controls a plain Member
 * could never use anyway. Editing your OWN job title happens self-service
 * on the Account tab through `people.profile.update` (`profile-section.tsx`),
 * which is why this screen hides its own edit controls for yourself: a
 * second path to the same field would drift.
 *
 * The admin-edit section used to render for everyone regardless of role,
 * pre-filled with the target's current job title/department/work phone,
 * and rely on the server to answer FORBIDDEN when a plain Member touched
 * Save (Phase 15 §1's sweep missed this screen the first time through).
 * Gated the same way `settings-page.tsx`'s own `PermissionsSection` is.
 *
 * Also wrapped in `CapabilityGate capability="viewDirectory"`, matching
 * `people.tsx`'s own fix — `people.directory.get` floors on the identical
 * `member:read`, and a deep link (or a Guest tapping through an org-chart
 * card before that fix existed) reached this screen the same way `people
 * .tsx` did, with the same raw-FORBIDDEN result.
 */
export default function PersonScreen() {
  const params = useLocalSearchParams<{ userId: string }>();
  const parsedUserId = UserIdSchema.safeParse(params.userId);

  if (!parsedUserId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This person link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return (
    <CapabilityGate capability="viewDirectory">
      <PersonContent userId={parsedUserId.data} />
    </CapabilityGate>
  );
}

function PersonContent({ userId }: { readonly userId: string }) {
  const paddingTop = useTopInset();
  const me = useSession((state) => state.userId);
  const canManageMembers =
    useQuery({
      queryKey: ORG_DETAIL_QUERY_KEY,
      queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
    }).data?.capabilities.manageMembers === true;

  const detail = useQuery({
    queryKey: directoryMemberQueryKey(userId),
    queryFn: async () => wire(await apiClient.people.directory.get.query({ userId })),
  });

  if (detail.isPending) {
    return (
      <View style={[styles.center, { paddingTop }]}>
        <SkeletonList count={3} />
      </View>
    );
  }

  if (detail.isError) {
    return (
      <View style={[styles.center, { paddingTop }]}>
        <Text style={styles.label}>
          {apiErrorOf(detail.error)?.error.message ?? "Couldn't load this person."}
        </Text>
        <BackButton />
      </View>
    );
  }

  const member = detail.data;
  const label = directoryLabel(member);

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <BackButton />

      <View style={styles.header}>
        <Avatar label={label} size={56} />
        <View style={styles.headerText}>
          <Text style={styles.headerName} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.headerEmail} numberOfLines={1}>
            {member.email}
            {member.userId === me && <Text style={styles.youMarker}> · you</Text>}
          </Text>
        </View>
        <View style={styles.roleBadge}>
          <Text style={styles.roleBadgeText}>{member.role}</Text>
        </View>
      </View>

      <View style={styles.chartRow}>
        <ChartCard
          title="Reports to"
          empty="No one — top of the chart."
          people={member.manager === null ? [] : [member.manager]}
        />
        <ChartCard
          title="Reports to them"
          empty="No direct reports yet."
          people={member.directReports}
        />
      </View>

      <Section label="Job" hint="Org-scoped facts about this membership.">
        {member.jobTitle === null && member.department === null && member.workPhone === null ? (
          <Text style={styles.emptyHint}>Nothing set yet.</Text>
        ) : (
          <View style={styles.jobRow}>
            {member.jobTitle !== null && <FactBadge text={member.jobTitle} />}
            {member.department !== null && <FactBadge text={member.department} />}
            {member.workPhone !== null && (
              <>
                <Text style={styles.workPhoneText}>{member.workPhone}</Text>
                <TelephonyCallButton to={member.workPhone} variant="primary" />
              </>
            )}
          </View>
        )}
      </Section>

      <OutOfOfficeSection member={member} />

      {member.userId !== me &&
        (canManageMembers ? (
          <AdminSection member={member} />
        ) : (
          <PersonFactsSummary member={member} />
        ))}
    </ScrollView>
  );
}

function ChartCard({
  title,
  empty,
  people,
}: {
  readonly title: string;
  readonly empty: string;
  readonly people: readonly ResolvedMember[];
}) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartCardTitle}>{title}</Text>
      {people.length === 0 ? (
        <Text style={styles.emptyHint}>{empty}</Text>
      ) : (
        people.map((person) => (
          <Pressable
            key={person.userId}
           
            style={styles.chartCardRow}
            onPress={() => {
              router.push(`/person/${person.userId}`);
            }}
          >
            <Avatar label={directoryLabel(person)} size={20} />
            <Text style={styles.chartCardRowText} numberOfLines={1}>
              {directoryLabel(person)}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

function FactBadge({ text }: { readonly text: string }) {
  return (
    <View style={styles.factBadge}>
      <Text style={styles.factBadgeText}>{text}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Out of office
 * -------------------------------------------------------------------------- */

function OutOfOfficeSection({ member }: { readonly member: DirectoryDetail }) {
  const from = parseNullableInstant(member.oooFrom);
  const until = parseNullableInstant(member.oooUntil);

  if (until === null) {
    return (
      <Section label="Out of office">
        <Text style={styles.emptyHint}>Not out of office.</Text>
      </Section>
    );
  }

  const started = from === null || isPast(from);

  return (
    <Section label="Out of office">
      <Text style={styles.oooLine}>
        {started ? 'Out now' : 'Scheduled'} · {from === null ? '' : `${dateLabel(from)} – `}
        {dateLabel(until)}
      </Text>
      {member.oooMessage !== null && <Text style={styles.oooMessage}>“{member.oooMessage}”</Text>}
    </Section>
  );
}

function dateLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/* -------------------------------------------------------------------------- *
 * Read-only presentable form (no member:manage)
 * -------------------------------------------------------------------------- */

/**
 * `AdminSection`'s read-only counterpart, matching web's own
 * `PersonFactsSummary` (`person-page.tsx`) — same four fields, no inputs,
 * no Save button.
 */
function PersonFactsSummary({ member }: { readonly member: DirectoryDetail }) {
  return (
    <Section label="Manage member" hint="Job facts and the reporting line.">
      <View style={styles.factRow}>
        <Text style={styles.factRowLabel}>Job title</Text>
        <Text style={styles.factRowValue}>{member.jobTitle ?? 'Not set'}</Text>
      </View>
      <View style={styles.factRow}>
        <Text style={styles.factRowLabel}>Department</Text>
        <Text style={styles.factRowValue}>{member.department ?? 'Not set'}</Text>
      </View>
      <View style={styles.factRow}>
        <Text style={styles.factRowLabel}>Work phone</Text>
        <Text style={styles.factRowValue}>{member.workPhone ?? 'Not set'}</Text>
      </View>
      <View style={styles.factRow}>
        <Text style={styles.factRowLabel}>Manager</Text>
        {member.manager === null ? (
          <Text style={styles.factRowValue}>No manager</Text>
        ) : (
          <Pressable
            onPress={() => {
              if (member.manager !== null) router.push(`/person/${member.manager.userId}`);
            }}
          >
            <Text style={styles.factRowLink}>{directoryLabel(member.manager)}</Text>
          </Pressable>
        )}
      </View>
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Admin: job facts + reporting line
 * -------------------------------------------------------------------------- */

function AdminSection({ member }: { readonly member: DirectoryDetail }) {
  const queryClient = useQueryClient();
  const [managerId, setManagerId] = useState(member.managerUserId ?? '');
  const [managerLabel, setManagerLabel] = useState<string | null>(
    member.manager === null ? null : directoryLabel(member.manager),
  );
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? '');
  const [department, setDepartment] = useState(member.department ?? '');
  const [workPhone, setWorkPhone] = useState(member.workPhone ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: directoryMemberQueryKey(member.userId) }),
      queryClient.invalidateQueries({ queryKey: DIRECTORY_QUERY_KEY }),
      // The dialable-people list is the directory folded down by work phone
      // (`telephony-contact-picker.tsx`), cached under its OWN key — so
      // setting a work phone here would leave the call composer's picker
      // without this person for its full stale window unless this says so.
      queryClient.invalidateQueries({ queryKey: PHONE_CONTACTS_QUERY_KEY }),
    ]);

  const setManager = useMutation({
    mutationFn: (input: { managerUserId: string | null }) =>
      apiClient.people.reportingLine.set.mutate({ userId: member.userId, ...input }),
    onSuccess: async () => {
      await invalidate();
      Alert.alert('Reporting line updated');
    },
    onError: (error) => {
      Alert.alert('Could not update the reporting line', apiErrorOf(error)?.error.message);
    },
  });

  const saveFacts = useMutation({
    mutationFn: () =>
      apiClient.people.membershipProfile.update.mutate({
        userId: member.userId,
        jobTitle: jobTitle.trim() === '' ? null : jobTitle.trim(),
        department: department.trim() === '' ? null : department.trim(),
        workPhone: workPhone.trim() === '' ? null : workPhone.trim(),
      }),
    onSuccess: async () => {
      await invalidate();
      Alert.alert('Profile updated');
    },
    onError: (error) => {
      Alert.alert('Could not save those details', apiErrorOf(error)?.error.message);
    },
  });

  // The directory is small (orgs are, by this app's own convention) and the
  // manager picker's options are needed the moment it opens, so it loads
  // with this section rather than on first tap.
  const directory = useQuery({
    queryKey: DIRECTORY_PICKER_QUERY_KEY,
    queryFn: async () => wire(await apiClient.people.directory.list.query({ limit: 100 })),
  });
  const candidates = (directory.data?.members ?? []).filter(
    (candidate) => candidate.userId !== member.userId,
  );

  const factsDirty =
    jobTitle.trim() !== (member.jobTitle ?? '') ||
    department.trim() !== (member.department ?? '') ||
    workPhone.trim() !== (member.workPhone ?? '');

  return (
    <Section label="Manage member" hint="Job facts and the reporting line.">
      <Text style={styles.fieldLabel}>Job title</Text>
      <TextInput
        style={styles.input}
        value={jobTitle}
        onChangeText={setJobTitle}
        placeholder="e.g. Staff engineer"
        placeholderTextColor={colors.inkFaint.hex}
        maxLength={120}
      />
      <Text style={styles.fieldLabel}>Department</Text>
      <TextInput
        style={styles.input}
        value={department}
        onChangeText={setDepartment}
        placeholder="e.g. Engineering"
        placeholderTextColor={colors.inkFaint.hex}
        maxLength={120}
      />
      <Text style={styles.fieldLabel}>Work phone — E.164, enables click-to-call</Text>
      <TextInput
        style={styles.input}
        value={workPhone}
        onChangeText={setWorkPhone}
        placeholder="+14155550100"
        placeholderTextColor={colors.inkFaint.hex}
        maxLength={16}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="phone-pad"
      />

      {factsDirty && (
        <Pressable
          style={[styles.secondaryButton, saveFacts.isPending && styles.buttonDisabled]}
          disabled={saveFacts.isPending}
          onPress={() => {
            saveFacts.mutate();
          }}
        >
          {saveFacts.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.secondaryButtonText}>Save details</Text>
          )}
        </Pressable>
      )}
      {saveFacts.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(saveFacts.error)?.error.message ?? 'Could not save those details.'}
        </Text>
      )}

      <Text style={[styles.fieldLabel, styles.managerLabel]}>Manager</Text>
      <Pressable
       
        style={styles.input}
        onPress={() => {
          setPickerOpen(true);
        }}
      >
        <Text style={managerLabel === null ? styles.placeholderText : styles.inputValueText}>
          {managerLabel ?? 'No manager'}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.primaryButton, setManager.isPending && styles.buttonDisabled]}
        disabled={setManager.isPending}
        onPress={() => {
          setManager.mutate({ managerUserId: managerId === '' ? null : managerId });
        }}
      >
        {setManager.isPending ? (
          <ActivityIndicator color={colors.accentInk.hex} />
        ) : (
          <Text style={styles.primaryButtonText}>Save manager</Text>
        )}
      </Pressable>
      {setManager.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(setManager.error)?.error.message ?? 'Could not update the reporting line.'}
        </Text>
      )}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Manager</Text>
            <ScrollView style={styles.modalList}>
              <Pressable
               
                style={styles.modalRow}
                onPress={() => {
                  setManagerId('');
                  setManagerLabel(null);
                  setPickerOpen(false);
                }}
              >
                <Text style={styles.modalRowText}>No manager</Text>
              </Pressable>
              {candidates.map((candidate) => (
                <Pressable
                  key={candidate.userId}
                 
                  style={styles.modalRow}
                  onPress={() => {
                    setManagerId(candidate.userId);
                    setManagerLabel(directoryLabel(candidate));
                    setPickerOpen(false);
                  }}
                >
                  <Text style={styles.modalRowText}>{directoryLabel(candidate)}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
             
              style={styles.modalCancel}
              onPress={() => {
                setPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Section>
  );
}

function Section({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {hint !== undefined && <Text style={styles.sectionHint}>{hint}</Text>}
      {children}
    </View>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 20,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  headerName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  headerEmail: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  youMarker: {
    color: colors.inkFaint.hex,
  },
  roleBadge: {
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  roleBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    textTransform: 'capitalize',
  },
  chartRow: {
    flexDirection: 'row',
    gap: 10,
  },
  chartCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    gap: 6,
    ...shadows.sm,
  },
  chartCardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  chartCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chartCardRowText: {
    flex: 1,
    fontSize: 12,
    color: colors.ink.hex,
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    marginTop: -4,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  factBadge: {
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  factBadgeText: {
    fontSize: 12,
    color: colors.ink.hex,
  },
  workPhoneText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  oooLine: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  oooMessage: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  factRowLabel: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  factRowValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  factRowLink: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  managerLabel: {
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  inputValueText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  placeholderText: {
    fontSize: 14,
    color: colors.inkFaint.hex,
  },
  primaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 10,
  },
  primaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  errorText: {
    fontSize: 12,
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
    maxHeight: '70%',
    ...shadows.lg,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  modalList: {
    maxHeight: 360,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 15,
    color: colors.ink.hex,
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
