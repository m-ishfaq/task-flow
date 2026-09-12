import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Building2,
  Check,
  CreditCard,
  ScrollText,
  Settings2,
  Shield,
  SlidersHorizontal,
  UserCog,
  Users,
  UsersRound,
} from 'lucide-react';
import {
  ModalContent,
  ModalDescription,
  ModalRoot,
  ModalTitle,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@taskflow/ui';
import type { TeamId, UserId } from '@taskflow/contracts';
import {
  DIRECTLY_ASSIGNABLE_ROLES,
  GRANTABLE_PERMISSIONS,
  ROLES,
  isGrantable,
  roleGrants,
  type Permission,
  type Role,
} from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import {
  AddPanel,
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  OrgBadge,
  PageContainer,
  PageHeader,
  SearchInput,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useBranding } from '../../lib/branding-context.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import {
  membersQuery,
  invitationsQuery,
  memberGrantsQuery,
  orgDetailQuery,
  roleDefaultGrantsQuery,
  type SettingsCapabilities,
} from '../org/api.js';
import { BillingSection } from './billing-section.js';

/**
 * Organization settings: the org itself, its members, its teams.
 *
 * Every route behind this page shipped in Phase 2, fully permissioned and
 * tested, and none of it was reachable — so an organization was permanently
 * single-user. The endpoints were not missing; the buttons were.
 *
 * ## Roles come from the policy package, never from a literal here
 *
 * `DIRECTLY_ASSIGNABLE_ROLES` is the same list `isDirectlyAssignable` checks on
 * the server. Owner is deliberately absent from it: transferring ownership is
 * not a role change, and offering it in this dropdown would render a control
 * that always fails. Hard-coding `['admin','member','guest']` here would work
 * until the matrix changed, and then silently disagree with it.
 *
 * ## Add first, then the list
 *
 * Every section here puts its ADD control above the collection it adds to. The
 * page is visited most often by someone who came to add a person or a team, and
 * a form underneath a list of forty members is a form nobody finds — the list
 * grows, the control moves further away, and the page gets worse the more it is
 * used. A fixed position at the top does not.
 */
type SettingsTab = 'general' | 'members' | 'permissions' | 'billing' | 'teams';

interface SettingsRailItem {
  readonly id: SettingsTab;
  readonly label: string;
  readonly icon: typeof Building2;
}

/**
 * The left-rail navigation — Design Bible §13's own thesis, named directly
 * in its subtitle: "a left-rail instead of one long scroll, one section at
 * a time." Every section below (`OrgSection`, `MemberSection`, ...) is
 * unchanged internally; this only changes which ONE of them is mounted at
 * a time, replacing the page's old single-column stack of every section
 * rendered at once.
 *
 * Gated the identical way the old stacked layout already was — a rail item
 * for a section the caller cannot reach (`viewDirectory`/`manageMembers`/
 * `viewBilling`/`viewTeams`, all already-computed server capabilities, per
 * §8.2) simply is not in the list, the same "hide, don't disable" rule
 * Phase 15 §1's own sweep already applies everywhere else in this app —
 * never a rail item that opens onto a raw FORBIDDEN.
 *
 * Local `useState`, not a URL search param — the same choice
 * `platform-admin-page.tsx`'s own tab switcher already made for the
 * closest precedent to this exact shape (a settings-style console with
 * several gated tabs), and nothing today deep-links into one specific
 * settings section (checked: no `/settings#members`-style link anywhere
 * in this app), so there is no bookmarkable state this pass would break
 * by not wiring one up.
 */
export function SettingsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  // Every section that renders fetches this same cached query itself for
  // its own inner capabilities, so reading it again here for the rail
  // costs no extra request.
  const org = useQuery(orgDetailQuery(orgId));
  const capabilities = org.data?.capabilities;

  const items: readonly SettingsRailItem[] = [
    { id: 'general', label: 'General', icon: Building2 },
    ...(capabilities?.viewDirectory === true
      ? [{ id: 'members' as const, label: 'Members', icon: Users }]
      : []),
    ...(capabilities?.manageMembers === true
      ? [{ id: 'permissions' as const, label: 'Permissions', icon: Shield }]
      : []),
    ...(capabilities?.viewBilling === true
      ? [{ id: 'billing' as const, label: 'Billing', icon: CreditCard }]
      : []),
    ...(capabilities?.viewTeams === true
      ? [{ id: 'teams' as const, label: 'Teams', icon: UsersRound }]
      : []),
  ];

  const [tab, setTab] = useState<SettingsTab>('general');
  // Falls back to the first still-available item rather than rendering
  // nothing — the same shape guards `platform-admin-page.tsx`'s own tab
  // state against a tab that WAS reachable when clicked and no longer is.
  const activeTab = items.some((item) => item.id === tab) ? tab : (items[0]?.id ?? 'general');

  return (
    <PageContainer maxWidth="xl">
      <PageHeader
        title="Organization settings"
        description="Members, teams, and who can reach what."
        icon={<SlidersHorizontal aria-hidden="true" className="size-4" strokeWidth={2.25} />}
      />

      <div className="mt-7 flex gap-6">
        <nav
          aria-label="Settings sections"
          className="w-52 shrink-0 space-y-0.5 self-start rounded-xl border border-line bg-surface-raised p-2"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activeTab === item.id ? 'page' : undefined}
              onClick={() => {
                setTab(item.id);
              }}
              className={cn(
                'relative flex w-full items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-3 text-left text-[13px] transition-colors duration-[var(--motion-fast)]',
                activeTab === item.id
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
              )}
            >
              {activeTab === item.id && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent"
                />
              )}
              <item.icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
              {item.label}
            </button>
          ))}

          {capabilities?.viewAuditLog === true && (
            <>
              <div aria-hidden="true" className="my-2 border-t border-line/60" />
              <Link
                to="/settings/audit"
                className="flex w-full items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-3 text-[13px] text-ink-muted transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover hover:text-ink"
              >
                <ScrollText aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                Audit log
              </Link>
            </>
          )}
        </nav>

        <div className="min-w-0 flex-1 space-y-9">
          {activeTab === 'general' && <OrgSection orgId={orgId} />}
          {activeTab === 'members' && capabilities?.viewDirectory === true && (
            <MemberSection orgId={orgId} />
          )}
          {activeTab === 'permissions' && capabilities?.manageMembers === true && (
            <>
              <RoleReferenceTable />
              <PermissionsSection orgId={orgId} />
              <RoleDefaultGrantsSection orgId={orgId} />
            </>
          )}
          {activeTab === 'billing' && capabilities?.viewBilling === true && (
            <BillingSection orgId={orgId} />
          )}
          {activeTab === 'teams' && capabilities?.viewTeams === true && (
            <TeamSection orgId={orgId} />
          )}
        </div>
      </div>
    </PageContainer>
  );
}

/* -------------------------------------------------------------------------- *
 * The organization
 * -------------------------------------------------------------------------- */

function OrgSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();

  const org = useQuery(orgDetailQuery(orgId));

  const [name, setName] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (value: string) => api.tenancy.orgs.update.mutate({ name: value }),
    onSuccess: async () => {
      setName(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.org(orgId) }),
        // The switcher renders the org name from its own query.
        queryClient.invalidateQueries({ queryKey: keys.orgs() }),
      ]);
    },
  });

  if (org.data === undefined) return null;
  const current = name ?? org.data.name;
  const canRename = org.data.capabilities.updateOrg;

  return (
    <Section
      title="Organization"
      icon={<Building2 aria-hidden="true" className="size-3.5" strokeWidth={2} />}
    >
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
        {/* An identity row — the same "avatar/name/facts" shape the org
            switcher already gives every org, made big here instead of the
            switcher's own compact list row. A settings page that only ever
            showed a bare text input had no visual sense that this screen is
            ABOUT a specific organization at all. */}
        <div className="flex items-center gap-3 border-b border-line/60 bg-surface-sunken/40 px-4 py-4">
          <OrgBadge orgId={orgId} name={org.data.name} className="size-12 rounded-xl text-lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{org.data.name}</p>
            <p className="text-xs text-ink-faint">
              <span className="font-mono text-ink-muted">{org.data.slug}</span> · created{' '}
              {formatDate(org.data.createdAt)}
            </p>
          </div>
        </div>

        <div className="p-4">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (current.trim() !== '' && current !== org.data.name) rename.mutate(current.trim());
            }}
          >
            <div className="flex-1">
              <Field label="Organization name" htmlFor="org-name">
                <Input
                  id="org-name"
                  value={current}
                  disabled={!canRename}
                  title={canRename ? undefined : 'Only the org Owner can rename the organization.'}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={!canRename || rename.isPending || current === org.data.name}
            >
              Save
            </Button>
          </form>

          <p className="mt-2 text-xs text-ink-faint">
            The slug is fixed — it appears in links that already exist.
          </p>
        </div>
      </div>

      {rename.isError && <ErrorText error={rename.error} />}
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Members
 * -------------------------------------------------------------------------- */

function MemberSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(orgId));
  const invitations = useQuery(invitationsQuery(orgId));
  const org = useQuery(orgDetailQuery(orgId));
  const { guard, dialog } = useStepUp();
  const currentUserId = useSession((state) => state.userId);
  const { productName } = useBranding();
  const toast = useToast();

  /* Same cache as OrgSection's own query (identical key), so this costs no
     extra request — React Query dedupes by key. Undefined only while the
     very first load of the page is still in flight; every control below
     defaults to hidden/disabled until it resolves, never the other way. */
  const capabilities: SettingsCapabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    viewDirectory: false,
    removeMembers: false,
    manageTeams: false,
    viewTeams: false,
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
    useAi: false,
    createBranches: false,
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.members(orgId) });
  const refreshInvitations = () =>
    queryClient.invalidateQueries({ queryKey: keys.invitations(orgId) });

  /**
   * Email invitations (migration 0107) — the door `members.add` was never
   * built to cover. Always sends mail, whether or not the address already
   * has a TaskFlow account: `invitations.send` answers the same
   * `{ status: 'invited' }` either way, so there is nothing here for the UI
   * to branch on. `members.add`'s own instant-add route still exists and is
   * still tested, but this is now the ONE form on this page — offering both
   * would ask an admin to guess which one an address needs.
   */
  const invite = useMutation({
    mutationFn: (input: { email: string; role: Role }) =>
      api.tenancy.invitations.send.mutate(input),
    onSuccess: refreshInvitations,
  });

  const revokeInvitation = useMutation({
    mutationFn: (invitationId: string) => api.tenancy.invitations.revoke.mutate({ invitationId }),
    onSuccess: refreshInvitations,
  });

  const changeRole = useMutation({
    mutationFn: (input: { userId: UserId; role: Role }) =>
      api.tenancy.members.changeRole.mutate(input),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        changeRole.mutate(input);
      });
    },
  });

  const remove = useMutation({
    mutationFn: (userId: UserId) => api.tenancy.members.remove.mutate({ userId }),
    onSuccess: refresh,
    onError: (error, userId) => {
      guard(error, () => {
        remove.mutate(userId);
      });
    },
  });

  /**
   * §8's own UI trigger — until this, nothing in the product could ever
   * FIRE `member.offboarding_started`, the trigger event every one of §8's
   * six new automation actions is written against (`ARGUMENTS` in
   * `vocabulary.ts`), so a rule built on it could never actually run.
   *
   * `member:remove`, matching `startOffboarding`'s own route — the same
   * permission `Remove` already gates, since flagging someone as leaving is
   * a strictly smaller action than actually removing them. No step-up
   * (`use-step-up.ts`'s `guard`): the route itself carries none, per its own
   * comment — nothing here is destructive or hard to undo, unlike `remove`.
   *
   * Success gets a toast rather than a visible row change, because there IS
   * no row change to show — `startOffboarding` writes no column at all
   * (`member.service.ts`'s own header), only the event. A silent success
   * here would read as "did that even do anything?" and invite a re-click,
   * which the route itself treats as harmless but still isn't the point.
   */
  const startOffboarding = useMutation({
    mutationFn: (target: { userId: UserId; email: string }) =>
      api.tenancy.members.startOffboarding.mutate({ userId: target.userId }),
    onSuccess: (_result, target) => {
      toast.show(`Offboarding started for ${target.email}`, {
        description: 'Any automation rules watching for this will run shortly.',
        tone: 'success',
      });
    },
    onError: (error) => {
      toast.failure('Could not start offboarding', error);
    },
  });

  /* Ownership transfer (Phase 12 Wave 1, §3.5) — a distinct action from the
     role dropdown, which keeps excluding 'owner' on purpose: you cannot ASSIGN
     the role, only hand it over whole. The dialog names the new owner AND the
     caller's resulting role because the transaction changes both rows at once
     and there is never an observable zero-owner moment in between.

     Candidates are everyone except the caller, deliberately unfiltered by
     role: the route answers FORBIDDEN for anyone who is not the Owner and the
     service refuses a guest jumping straight to owner ("promote them first"),
     so the UI offers the action to everyone and the server decides — the same
     shape as every other permission-gated control on this page. Filtering the
     candidate list by role here would be the UI re-deriving authorization,
     which is exactly what §8.2 forbids. */
  const transferCandidates = (members.data ?? []).filter(
    (member) => member.userId !== currentUserId,
  );

  const transfer = useMutation({
    mutationFn: (input: { toUserId: UserId; selfNewRole: 'admin' | 'member' }) =>
      api.tenancy.members.transferOwnership.mutate(input),
    onSuccess: async () => {
      setTransferOpen(false);
      await refresh();
    },
    onError: (error, input) => {
      guard(error, () => {
        transfer.mutate(input);
      });
    },
  });

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferSelfRole, setTransferSelfRole] = useState<'admin' | 'member'>('admin');

  const openTransfer = () => {
    /* Preselect the first candidate so the confirm button is live the moment
       the dialog opens — a dialog whose only action starts disabled with no
       explanation is a dialog nobody fills in. */
    setTransferTo(transferCandidates[0]?.userId ?? '');
    setTransferOpen(true);
  };

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');

  /* Only worth the box past a handful of members — same threshold
     `assignee-section.tsx` uses for the identical reason: the demo `large`
     seed profile alone puts 60 people in one org, and scrolling past fifty
     rows to find one is the thing this fixes. */
  const [memberSearch, setMemberSearch] = useState('');
  const memberNeedle = memberSearch.trim().toLowerCase();
  const visibleMembers = (members.data ?? []).filter(
    (member) =>
      memberNeedle === '' ||
      member.email.toLowerCase().includes(memberNeedle) ||
      (member.displayName?.toLowerCase().includes(memberNeedle) ?? false),
  );

  return (
    <Section
      title="Members"
      icon={<Users aria-hidden="true" className="size-3.5" strokeWidth={2} />}
      count={members.data?.length}
      description="Everyone with access to this organization. A role decides what they can do across it; a team grant can narrow or widen that on one resource."
    >
      {/* A whole multi-field form nobody without member:invite could ever
          submit is clutter, not information — unlike the org-name field
          above, there is nothing here worth seeing disabled. Hidden rather
          than shown-and-refused; the member LIST below still renders fully,
          so nothing about visibility into the org is lost, only the ability
          to change it. */}
      {capabilities.inviteMember && (
        <AddPanel>
          <form
            className="flex flex-wrap gap-2 items-center"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim() !== '') {
                invite.mutate(
                  { email: email.trim(), role },
                  {
                    onSuccess: () => {
                      setEmail('');
                    },
                  },
                );
              }
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field
                label="Invite a member"
                htmlFor="member-email"
                hint={`We'll email an invitation link. Works whether or not they already have a ${productName} account.`}
              >
                <Input
                  id="member-email"
                  type="email"
                  placeholder="colleague@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                />
              </Field>
            </div>

            <select
              aria-label="Role for the new member"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as Role);
              }}
              className="h-9 rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
            >
              {DIRECTLY_ASSIGNABLE_ROLES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>

            <Button
              type="submit"
              variant="primary"
              disabled={invite.isPending || email.trim() === ''}
            >
              {invite.isPending ? 'Sending…' : 'Invite'}
            </Button>
          </form>

          {invite.isError && <ErrorText error={invite.error} />}
        </AddPanel>
      )}

      {capabilities.inviteMember &&
        invitations.data !== undefined &&
        invitations.data.length > 0 && (
          <div className="rounded-xl border border-line/50 p-3">
            <div className="mb-2 text-xs font-medium text-ink-muted">
              Pending invitations ({invitations.data.length})
            </div>
            <ul className="divide-y divide-line/40">
              {invitations.data.map((invitation) => (
                <li
                  key={invitation.invitationId}
                  className="flex items-center justify-between gap-2 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate text-ink">{invitation.email}</div>
                    <div className="text-xs text-ink-muted">
                      Invited as {invitation.role} · expires {formatDate(invitation.expiresAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={invite.isPending}
                      onClick={() => {
                        invite.mutate({ email: invitation.email, role: invitation.role as Role });
                      }}
                    >
                      Resend
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={revokeInvitation.isPending}
                      className="text-ink-muted hover:text-danger"
                      onClick={() => {
                        revokeInvitation.mutate(invitation.invitationId);
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {revokeInvitation.isError && <ErrorText error={revokeInvitation.error} />}
          </div>
        )}

      {/* Ownership has exactly one holder, so this button is NEVER usable by
          anyone but the current Owner — not "usually not," never. That is
          different from every other control on this page (an Admin might
          plausibly gain member:invite later; nobody gains "is the current
          Owner" by having a role), so hiding it for non-Owners is complete,
          not just today's approximation. The server is still what actually
          enforces it (member:manage) — this only stops showing the action to
          the (org.memberCount - 1) people who structurally cannot take it. */}
      {capabilities.manageMembers && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={transferCandidates.length === 0}
            title={
              transferCandidates.length === 0
                ? 'There is nobody else to transfer to yet.'
                : undefined
            }
            onClick={openTransfer}
            className="text-ink-muted hover:text-ink"
          >
            Transfer ownership…
          </Button>
        </div>
      )}

      {members.isPending && <SkeletonRows rows={4} className="*:h-12" />}
      {members.isError && <ErrorView error={members.error} title="Could not load members" />}

      {members.data !== undefined && (
        <>
          {members.data.length > 8 && (
            <SearchInput
              aria-label="Search members"
              placeholder="Search by name or email…"
              value={memberSearch}
              onChange={setMemberSearch}
              className="mb-2 max-w-xs"
            />
          )}

          {visibleMembers.length === 0 ? (
            <Empty title="No members match your search" />
          ) : (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-xl border border-line/50">
              {visibleMembers.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  isSelf={member.userId === currentUserId}
                  busy={changeRole.isPending || remove.isPending}
                  canChangeRole={capabilities.manageMembers}
                  canRemove={capabilities.removeMembers}
                  offboardingBusy={startOffboarding.isPending}
                  onRoleChange={(next) => {
                    changeRole.mutate({ userId: member.userId as UserId, role: next });
                  }}
                  onRemove={() => {
                    remove.mutate(member.userId as UserId);
                  }}
                  onStartOffboarding={() => {
                    startOffboarding.mutate({
                      userId: member.userId as UserId,
                      email: member.email,
                    });
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {changeRole.isError && <ErrorText error={changeRole.error} />}
      {remove.isError && <ErrorText error={remove.error} />}

      {transferOpen && (
        <ModalRoot
          open
          onOpenChange={(next) => {
            if (!next) setTransferOpen(false);
          }}
        >
          <ModalContent size="sm" className="p-4">
            <ModalTitle>Transfer ownership</ModalTitle>
            <ModalDescription>
              The new owner gets everything Owner allows, immediately. You become an{' '}
              {transferSelfRole} in the same transaction — there is never a moment with no owner.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (transferTo !== '') {
                  transfer.mutate({
                    toUserId: transferTo as UserId,
                    selfNewRole: transferSelfRole,
                  });
                }
              }}
            >
              <Field label="New owner" htmlFor="transfer-to">
                <select
                  id="transfer-to"
                  value={transferTo}
                  onChange={(event) => {
                    setTransferTo(event.target.value);
                  }}
                  className="h-9 w-full rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
                >
                  {transferCandidates.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.email} ({member.role})
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Your role afterwards" htmlFor="transfer-self-role">
                <select
                  id="transfer-self-role"
                  value={transferSelfRole}
                  onChange={(event) => {
                    setTransferSelfRole(event.target.value as 'admin' | 'member');
                  }}
                  className="h-9 w-full rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
              </Field>

              {transfer.isError && <ErrorText error={transfer.error} />}

              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={transfer.isPending || transferTo === ''}
                >
                  {transfer.isPending ? 'Transferring…' : 'Transfer ownership'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTransferOpen(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </ModalContent>
        </ModalRoot>
      )}

      {dialog}
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Individual permission grants (ai/phase-15-ai-copilot-and-permissions.md §1)
 * -------------------------------------------------------------------------- */

/**
 * One org-level permission given to (or taken from) one specific member, on
 * top of their role — e.g. letting one Guest place calls without promoting
 * them to Member. `GRANTABLE_PERMISSIONS` is the same closed list the server
 * enforces (`packages/policy`'s `isGrantable`), imported rather than
 * hand-copied so a permission added there appears here without a second edit.
 *
 * ## A list of grants, not a member × permission matrix
 *
 * The first version of this section rendered every member as a row and every
 * grantable permission as a COLUMN. That reads fine at 5 permissions and a
 * handful of members and stops being usable almost immediately after —
 * `GRANTABLE_PERMISSIONS` growing past a screen's width turns it into
 * sideways scrolling, and an org with real headcount turns it into a wall of
 * mostly-off toggles nobody can scan. What anyone actually needs to see is
 * "who currently has an extra grant, and what" — a short, sparse list — so
 * this follows the same "add first, then the list" shape the Members section
 * above uses: a list of only the grants that actually exist, below a form
 * that CREATES them. It grows with usage, not with headcount × catalog size.
 * `GRANTABLE_PERMISSIONS` doubling in Wave 2 (automation permissions joining
 * telephony's original five) is the reason this stays true rather than a
 * reason to reconsider it — a matrix's cost is exactly `members × catalog
 * size`, so it only gets worse as the catalog grows, which is the direction
 * it is actually moving.
 *
 * ## The add form is a batch, not a single pair
 *
 * Both pickers below are multi-select: choosing 3 members and 2 permissions
 * and submitting once grants the full 3×2 Cartesian product, not one pair.
 * This is what actually needed fixing — not the LIST's shape, which already
 * scales, but the one-member-one-permission-per-click workflow needed to
 * populate it, which did not: giving one person several abilities, or one
 * ability to several people, or several people several abilities all at
 * once, were each N separate trips through the form. `runGrantBatch` below
 * still calls the server's existing single-pair `memberGrants.grant` route
 * once per pair in sequence — there is no new bulk endpoint — which is safe
 * ONLY because that route is already idempotent (granting something already
 * granted returns the existing row, per `member-grant.service.ts`'s own
 * comment): a batch that fails partway through step-up is retried from
 * index 0 in full, and every pair before the failure point silently no-ops
 * on the retry rather than erroring or duplicating.
 *
 * The member picker is the same type-to-filter Popover list
 * `assignee-section.tsx` and `card-tile.tsx`'s `QuickAssignee` already use —
 * this is a further occurrence of that pattern, not a new one; see that
 * file's own note on pulling it into a shared component once a good moment
 * presents itself, not forced here. It has grown a checkbox per row rather
 * than closing on selection, so several members can be picked without
 * reopening the popover between each one.
 *
 * ## The list gained the same batching, in reverse
 *
 * Each row has its own checkbox now; checking several and confirming
 * "Revoke selected" revokes all of them, the same `runRevokeBatch` shape as
 * the grant side — sequential calls to the existing single-pair
 * `memberGrants.revoke` route, retried from the start of the SELECTION on a
 * step-up interruption. This is why `revoke()` in
 * `member-grant.service.ts` had to gain the identical idempotency `grant()`
 * already had: without it, retrying a partially-completed revoke batch
 * would 404 on the pairs it already revoked before the interruption and
 * abort whatever was left selected. The single per-row "Revoke" button
 * stays too, for the common one-off case that does not need a checkbox
 * first.
 *
 * The whole section is gated on `capabilities.manageMembers`
 * (`SettingsPage`'s own render), not just the add form and revoke buttons
 * inside it — even though `memberGrants.list`'s own floor is `member:read`
 * (every role). Seeing the LIST tells a caller exactly which individual
 * permission each of their colleagues holds, which is administrative
 * information about other people, not something "you can see the Members
 * page" should imply on its own. `member:manage` is Owner-only
 * (`packages/policy/src/roles.ts`), so in practice this section is Owner-only
 * end to end, matching who can act on it anyway.
 */

/**
 * A static reference of what each role holds, at a glance — Design Bible
 * §19's own thesis: "it's three real tools now: a role reference, individual
 * grants, and a decision explainer." This is the first of the three, sitting
 * above the individual-grants list (`PermissionsSection`, below) rather than
 * replacing it: most "can this person do X" questions have an obvious answer
 * once the shape of the four roles is visible on one screen, and the
 * decision explainer (`/settings` → the permission debugger) stays for the
 * ones that genuinely need a specific person and a specific resource traced
 * through `can()`.
 *
 * Computed entirely from `packages/policy`'s own exported role/permission
 * data (`roleGrants`, `isGrantable`) — never a second, hand-maintained
 * copy of what `can()` actually decides. `ROLE_REFERENCE` below is the one
 * hand-curated part: WHICH permissions to show, the same "written for a
 * person, not a developer reference" trade `assistant-page.tsx`'s own
 * `CAPABILITIES` constant already makes — eleven representative capabilities
 * rather than every one of `PERMISSIONS`' ~60 entries.
 *
 * The Guest column is deliberately narrower than a full account of what a
 * Guest can reach: it reflects only the ORG-LEVEL individual grant
 * (`memberGrants.grant`, the exact mechanism the list below uses, and
 * genuinely role-agnostic — nothing in that route restricts the recipient's
 * role, confirmed against `member-grant.service.ts` and this page's own
 * member-picker, which filters by nothing but a name/email search). A
 * Guest's RESOURCE-scoped access — read, comment, or edit on one project via
 * a relationship tuple — is a real, separate, already-shipped mechanism
 * ("Guest access into Work", reached from that project's own Share panel),
 * deliberately NOT modeled here: correctly reproducing which permissions a
 * viewer/commenter/editor tuple can satisfy for an arbitrary resource type
 * needs walking the exact ancestor-resolution `enforceOn` does, and
 * asserting that without verifying it against the real engine risks this
 * table showing something `can()` itself would refuse — a materially worse
 * failure, on a human-review-flagged surface, than an incomplete legend.
 */
const ROLE_REFERENCE: readonly { readonly label: string; readonly permission: Permission }[] = [
  { label: 'View projects & boards', permission: 'project:read' },
  { label: 'Create & edit cards', permission: 'card:update' },
  { label: 'Comment', permission: 'comment:create' },
  { label: 'Manage boards & sprints', permission: 'board:update' },
  { label: 'Manage members', permission: 'member:manage' },
  { label: 'View analytics', permission: 'analytics:read' },
  { label: 'Place calls · send SMS', permission: 'call:place' },
  { label: 'Manage automations', permission: 'automation:manage' },
  { label: 'Review pull requests', permission: 'pr:review' },
  { label: 'Manage billing', permission: 'org:billing' },
  { label: 'Delete organization', permission: 'org:delete' },
];

function RoleReferenceTable() {
  return (
    <Section
      title="Role reference"
      icon={<Shield aria-hidden="true" className="size-3.5" strokeWidth={2} />}
      description="What each role holds, at a glance."
    >
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-surface-sunken/60 text-[11px] font-medium tracking-wide text-ink-faint uppercase">
              <th className="px-3 py-2">Capability</th>
              {ROLES.map((role) => (
                <th key={role} className="px-3 py-2 text-center capitalize">
                  {role}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLE_REFERENCE.map((row) => (
              <tr key={row.permission} className="border-b border-line/60 last:border-b-0">
                <td className="px-3 py-2 text-ink">{row.label}</td>
                {ROLES.map((role) => (
                  <td key={role} className="px-3 py-2 text-center">
                    <RoleReferenceCell role={role} permission={row.permission} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">
        A Guest&apos;s per-project access — invited to read, comment on, or edit one project&apos;s
        own boards and cards — is a separate mechanism, granted from that project&apos;s own Share
        panel rather than here.
      </p>
    </Section>
  );
}

function RoleReferenceCell({
  role,
  permission,
}: {
  readonly role: Role;
  readonly permission: Permission;
}) {
  if (roleGrants(role, permission)) {
    return (
      <span className="inline-flex items-center justify-center">
        <Check aria-hidden="true" className="size-4 text-success" strokeWidth={2.5} />
        <span className="sr-only">Included</span>
      </span>
    );
  }
  if (isGrantable(permission)) {
    return <Badge tone="accent">Grant</Badge>;
  }
  return (
    <span aria-hidden="true" className="text-ink-faint/40">
      —
    </span>
  );
}

function PermissionsSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(orgId));
  const grants = useQuery(memberGrantsQuery(orgId));
  const org = useQuery(orgDetailQuery(orgId));
  const { guard, dialog } = useStepUp();

  const capabilities: SettingsCapabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    viewDirectory: false,
    removeMembers: false,
    manageTeams: false,
    viewTeams: false,
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
    useAi: false,
    createBranches: false,
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.memberGrants(orgId) });

  /**
   * One pair per member × permission chosen in the form, sent to the
   * existing single-pair route in sequence. Sequential rather than
   * `Promise.all` — a batch that fails at pair 4 of 10 with a batch of
   * concurrent in-flight requests leaves an unknowable subset applied;
   * sequential means "the ones before the failure succeeded" is always
   * true, which is what makes retrying the WHOLE array from index 0 safe
   * (each already-applied pair no-ops on the idempotent route rather than
   * erroring).
   */
  const runGrantBatch = async (
    pairs: readonly { readonly userId: UserId; readonly permission: string }[],
  ): Promise<void> => {
    for (const pair of pairs) {
      await api.tenancy.memberGrants.grant.mutate(pair);
    }
  };

  const bulkGrant = useMutation({
    mutationFn: runGrantBatch,
    onSuccess: async () => {
      setPickedUserIds(new Set());
      setPickedPermissions(new Set());
      setMemberQuery('');
      await refresh();
    },
    onError: (error, pairs) => {
      guard(error, () => {
        bulkGrant.mutate(pairs);
      });
    },
  });

  const revoke = useMutation({
    mutationFn: (input: { userId: UserId; permission: string }) =>
      api.tenancy.memberGrants.revoke.mutate(input),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        revoke.mutate(input);
      });
    },
  });

  /**
   * Bulk revoke — the list's own counterpart to the add form's bulk grant.
   * Same shape: sequential calls to the existing single-pair route, retried
   * from the start of the SELECTION on a step-up interruption. Safe for the
   * identical reason the grant batch is, now that `member-grant.service.ts`'s
   * `revoke()` is ALSO idempotent on "nothing to revoke" — a pair the batch
   * already revoked before an interruption no-ops on retry instead of
   * throwing NOT_FOUND and aborting whatever was left in the selection.
   */
  const runRevokeBatch = async (
    pairs: readonly { readonly userId: UserId; readonly permission: string }[],
  ): Promise<void> => {
    for (const pair of pairs) {
      await api.tenancy.memberGrants.revoke.mutate(pair);
    }
  };

  const bulkRevoke = useMutation({
    mutationFn: runRevokeBatch,
    onSuccess: async () => {
      setSelectedGrants(new Set());
      await refresh();
    },
    onError: (error, pairs) => {
      guard(error, () => {
        bulkRevoke.mutate(pairs);
      });
    },
  });

  const permissions = [...GRANTABLE_PERMISSIONS];

  const [pickedUserIds, setPickedUserIds] = useState<ReadonlySet<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState('');
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [pickedPermissions, setPickedPermissions] = useState<ReadonlySet<string>>(new Set());
  const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);

  const [grantSearch, setGrantSearch] = useState('');
  /* Keyed `${userId}:${permission}`, matching each row's own `key` prop —
     the same composite identity the list already uses, reused rather than
     invented a second time. Persists across a search filter change: hiding
     a selected row does not un-select it, matching how a checkbox list
     elsewhere in this app (e.g. an inbox) usually behaves. */
  const [selectedGrants, setSelectedGrants] = useState<ReadonlySet<string>>(new Set());

  const toggleGrantSelection = (key: string) => {
    setSelectedGrants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
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

  if (members.data === undefined || grants.data === undefined) return null;

  const labelOf = (member: { readonly email: string; readonly displayName: string | null }) =>
    member.displayName ?? member.email;

  const memberById = new Map(members.data.map((member) => [member.userId, member]));
  const submitCount = pickedUserIds.size * pickedPermissions.size;

  const needle = memberQuery.trim().toLowerCase();
  const matches =
    needle === ''
      ? members.data
      : members.data.filter(
          (member) =>
            member.email.toLowerCase().includes(needle) ||
            (member.displayName?.toLowerCase().includes(needle) ?? false),
        );

  const grantNeedle = grantSearch.trim().toLowerCase();
  const visibleGrants = grants.data.filter((entry) => {
    if (grantNeedle === '') return true;
    const member = memberById.get(entry.userId);
    const label = member ? labelOf(member).toLowerCase() : '';
    return label.includes(grantNeedle) || entry.permission.toLowerCase().includes(grantNeedle);
  });

  /**
   * One row per PERSON, not per (member, permission) pair — the same grants
   * `visibleGrants` already holds, regrouped for display. A search still
   * narrows at the GRANT level (a query matching one of someone's three
   * permissions shows only that one chip, not all three), since grouping
   * happens after filtering, not before. `Map` rather than an index-tracked
   * array: an object each entry can push into by reference needs no
   * indexed-access fallback under `noUncheckedIndexedAccess`, and insertion
   * order — the same order `visibleGrants` is already in — is exactly the
   * iteration order a `Map` guarantees for free.
   */
  const groupsByUserId = new Map<
    string,
    {
      readonly userId: string;
      readonly member: (typeof members.data)[number] | undefined;
      readonly items: { readonly permission: string; readonly grantedAt: string }[];
    }
  >();
  for (const entry of visibleGrants) {
    const existing = groupsByUserId.get(entry.userId);
    if (existing !== undefined) {
      existing.items.push({ permission: entry.permission, grantedAt: entry.grantedAt });
    } else {
      groupsByUserId.set(entry.userId, {
        userId: entry.userId,
        member: memberById.get(entry.userId),
        items: [{ permission: entry.permission, grantedAt: entry.grantedAt }],
      });
    }
  }
  const groupedGrants = [...groupsByUserId.values()];

  return (
    <Section
      title="Individual permissions"
      icon={<UserCog aria-hidden="true" className="size-3.5" strokeWidth={2} />}
      count={grants.data.length}
      description="On top of a member's role, one specific ability can be given to (or taken from) one person — e.g. letting one guest place calls without promoting them to Member."
    >
      {capabilities.manageMembers && permissions.length > 0 && (
        <AddPanel>
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (submitCount === 0) return;
              const pairs: { readonly userId: UserId; readonly permission: string }[] = [];
              for (const userId of pickedUserIds) {
                for (const perm of pickedPermissions) {
                  pairs.push({ userId: userId as UserId, permission: perm });
                }
              }
              bulkGrant.mutate(pairs);
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field label="Members" htmlFor="grant-member-search">
                <PopoverRoot
                  open={memberPickerOpen}
                  onOpenChange={(open) => {
                    setMemberPickerOpen(open);
                    if (!open) setMemberQuery('');
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      id="grant-member-search"
                      className="flex h-9 w-full items-center rounded-lg border border-line/50 bg-surface px-2 text-left text-sm text-ink"
                    >
                      {pickedUserIds.size === 0 ? (
                        <span className="text-ink-faint">Search by name or email…</span>
                      ) : (
                        <span>
                          {pickedUserIds.size} member{pickedUserIds.size === 1 ? '' : 's'} selected
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 space-y-1.5 p-2">
                    <SearchInput
                      aria-label="Search members"
                      placeholder="Search by name or email…"
                      value={memberQuery}
                      onChange={setMemberQuery}
                      className="h-8"
                    />
                    {matches.length === 0 ? (
                      <p className="p-1 text-xs text-ink-faint">No matches.</p>
                    ) : (
                      <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                        {matches.map((member) => (
                          <li key={member.userId}>
                            <button
                              type="button"
                              onClick={() => {
                                toggleUser(member.userId);
                              }}
                              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                            >
                              <input
                                type="checkbox"
                                readOnly
                                checked={pickedUserIds.has(member.userId)}
                                className="pointer-events-none"
                              />
                              <Avatar userId={member.userId} label={labelOf(member)} size="xs" />
                              <span className="truncate">{labelOf(member)}</span>
                              <span className="ml-auto text-ink-faint">{member.role}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </PopoverContent>
                </PopoverRoot>
                {pickedUserIds.size > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {[...pickedUserIds].map((userId) => {
                      const member = memberById.get(userId);
                      const label = member ? labelOf(member) : userId;
                      return (
                        <span
                          key={userId}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink"
                        >
                          {label}
                          <button
                            type="button"
                            onClick={() => {
                              toggleUser(userId);
                            }}
                            aria-label={`Remove ${label}`}
                            className="text-ink-faint hover:text-ink"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </Field>
            </div>

            <div className="min-w-[12rem]">
              <Field label="Permissions" htmlFor="grant-permission-picker">
                <PopoverRoot open={permissionPickerOpen} onOpenChange={setPermissionPickerOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      id="grant-permission-picker"
                      className="flex h-9 w-full items-center rounded-lg border border-line/50 bg-surface px-2 text-left text-sm text-ink"
                    >
                      {pickedPermissions.size === 0 ? (
                        <span className="text-ink-faint">Choose permissions…</span>
                      ) : (
                        <span>{pickedPermissions.size} selected</span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 space-y-0.5 p-2">
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                      {permissions.map((entry) => (
                        <li key={entry}>
                          <button
                            type="button"
                            onClick={() => {
                              togglePermission(entry);
                            }}
                            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                          >
                            <input
                              type="checkbox"
                              readOnly
                              checked={pickedPermissions.has(entry)}
                              className="pointer-events-none"
                            />
                            <span className="truncate font-mono">{entry}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </PopoverRoot>
                {pickedPermissions.size > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {[...pickedPermissions].map((entry) => (
                      <span
                        key={entry}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink"
                      >
                        {entry}
                        <button
                          type="button"
                          onClick={() => {
                            togglePermission(entry);
                          }}
                          aria-label={`Remove ${entry}`}
                          className="text-ink-faint hover:text-ink"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>
            </div>

            <Button
              type="submit"
              variant="primary"
              disabled={bulkGrant.isPending || submitCount === 0}
            >
              {bulkGrant.isPending
                ? 'Granting…'
                : submitCount > 1
                  ? `Grant (${String(submitCount)})`
                  : 'Grant'}
            </Button>
          </form>

          {bulkGrant.isError && <ErrorText error={bulkGrant.error} />}
        </AddPanel>
      )}

      {grants.data.length === 0 ? (
        <Empty title="No individual grants yet" />
      ) : (
        <>
          {grants.data.length > 8 && (
            <Input
              aria-label="Search grants"
              placeholder="Search by member or permission…"
              value={grantSearch}
              onChange={(event) => {
                setGrantSearch(event.target.value);
              }}
              className="mb-2 h-9 max-w-xs text-sm"
            />
          )}

          {capabilities.manageMembers && selectedGrants.size > 0 && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-line/50 bg-surface-raised px-3 py-2">
              <span className="text-xs text-ink-muted">{selectedGrants.size} selected</span>
              <ConfirmButton
                label={
                  bulkRevoke.isPending
                    ? 'Revoking…'
                    : `Revoke selected (${String(selectedGrants.size)})`
                }
                confirmLabel="Revoke all selected?"
                size="sm"
                disabled={bulkRevoke.isPending}
                onConfirm={() => {
                  const pairs = [...selectedGrants].map((key) => {
                    const separatorIndex = key.indexOf(':');
                    return {
                      userId: key.slice(0, separatorIndex) as UserId,
                      permission: key.slice(separatorIndex + 1),
                    };
                  });
                  bulkRevoke.mutate(pairs);
                }}
              />
              <button
                type="button"
                className="ml-auto text-xs text-ink-faint hover:text-ink"
                onClick={() => {
                  setSelectedGrants(new Set());
                }}
              >
                Clear
              </button>
            </div>
          )}

          {visibleGrants.length === 0 ? (
            <Empty title="No grants match your search" />
          ) : (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-xl border border-line/50">
              {groupedGrants.map((group) => {
                const label = group.member ? labelOf(group.member) : group.userId;
                const keysForPerson = group.items.map(
                  (item) => `${group.userId}:${item.permission}`,
                );
                const allSelected = keysForPerson.every((key) => selectedGrants.has(key));
                const someSelected = keysForPerson.some((key) => selectedGrants.has(key));

                return (
                  <li key={group.userId} className="flex items-start gap-3 px-3 py-3">
                    {capabilities.manageMembers && (
                      <input
                        type="checkbox"
                        aria-label={`Select all permissions for ${label}`}
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = !allSelected && someSelected;
                        }}
                        onChange={() => {
                          setSelectedGrants((prev) => {
                            const next = new Set(prev);
                            for (const key of keysForPerson) {
                              if (allSelected) next.delete(key);
                              else next.add(key);
                            }
                            return next;
                          });
                        }}
                        className="mt-1"
                      />
                    )}
                    <Avatar userId={group.userId} label={label} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{label}</span>
                        <span className="text-xs text-ink-faint">
                          {group.member?.role ?? 'former member'}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {group.items.map((item) => {
                          const key = `${group.userId}:${item.permission}`;
                          return (
                            <PermissionGrantChip
                              key={key}
                              permission={item.permission}
                              grantedAt={item.grantedAt}
                              selectable={capabilities.manageMembers}
                              selected={selectedGrants.has(key)}
                              onToggleSelect={() => {
                                toggleGrantSelection(key);
                              }}
                              revocable={capabilities.manageMembers}
                              revokePending={revoke.isPending}
                              onRevoke={() => {
                                revoke.mutate({
                                  userId: group.userId as UserId,
                                  permission: item.permission,
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {revoke.isError && <ErrorText error={revoke.error} />}
      {bulkRevoke.isError && <ErrorText error={bulkRevoke.error} />}
      {dialog}
    </Section>
  );
}

/**
 * One permission, as its own small pill inside a person's grouped row —
 * the grant date sits IN the chip rather than behind a `title` hover, since
 * a browser tooltip is easy to miss and the date was exactly what got asked
 * for as visible, not merely discoverable. Revoking a single permission
 * stays a two-step confirm, the same shape `ConfirmButton` gives every other
 * irreversible-enough action in this app, just built inline here rather than
 * with that component directly — `ConfirmButton`'s own `label` is a whole
 * button's text, sized for a row, not a compact pill that also has to hold a
 * permission name and a date on one line.
 */
function PermissionGrantChip({
  permission,
  grantedAt,
  selectable,
  selected,
  onToggleSelect,
  revocable,
  revokePending,
  onRevoke,
}: {
  readonly permission: string;
  readonly grantedAt: string;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onToggleSelect: () => void;
  readonly revocable: boolean;
  readonly revokePending: boolean;
  readonly onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1.5 text-xs transition-colors',
        selected ? 'border-accent/50 bg-accent/10' : 'border-line/50 bg-surface-sunken',
      )}
    >
      {selectable && (
        <input
          type="checkbox"
          aria-label={`Select ${permission}`}
          checked={selected}
          onChange={onToggleSelect}
          className="size-3"
        />
      )}
      <span className="font-mono font-medium text-ink">{permission}</span>
      <span className="text-[10px] text-ink-faint">· {formatDate(grantedAt)}</span>
      {revocable &&
        (confirming ? (
          <span className="flex items-center gap-1 border-l border-line/50 pl-1.5">
            <button
              type="button"
              disabled={revokePending}
              onClick={() => {
                onRevoke();
                setConfirming(false);
              }}
              className="text-[10px] font-medium text-danger hover:underline disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="text-[10px] text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Revoke ${permission}`}
            title={`Revoke ${permission}`}
            disabled={revokePending}
            onClick={() => {
              setConfirming(true);
            }}
            className="ml-0.5 rounded-md text-ink-faint hover:text-danger disabled:opacity-50"
          >
            ×
          </button>
        ))}
    </span>
  );
}

/**
 * Only `member` and `guest` are configurable rows in the matrix below —
 * `owner` and `admin` already hold every individually-grantable permission
 * BY ROLE (`packages/policy`'s `ROLE_PERMISSIONS`), so a checkbox for
 * either would be either always-checked-and-inert or a control that lies
 * about what it does.
 */
const CONFIGURABLE_ROLES: readonly Role[] = ['member', 'guest'];

/**
 * A role's default permission bundle (Phase 15 §8 checklist item 3) — what
 * `member_grant.apply_role_defaults` (a NEW AUTOMATION ACTION, not this
 * section) applies to a member of that role, if and when an org builds a
 * rule on "Someone joins the organization" that uses it. This section only
 * edits the CONFIG; nothing here grants anything to anyone directly, which
 * is why the description below says so explicitly — a checkbox in a
 * "Permissions" area reads as an immediate grant unless told otherwise.
 */
function RoleDefaultGrantsSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const roleGrants = useQuery(roleDefaultGrantsQuery(orgId));
  const org = useQuery(orgDetailQuery(orgId));
  const { guard, dialog } = useStepUp();

  const capabilities: SettingsCapabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    viewDirectory: false,
    removeMembers: false,
    manageTeams: false,
    viewTeams: false,
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
    useAi: false,
    createBranches: false,
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.roleDefaultGrants(orgId) });

  const setGrant = useMutation({
    mutationFn: (input: { readonly role: Role; readonly permission: string }) =>
      api.tenancy.roleDefaultGrants.set.mutate(input),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        setGrant.mutate(input);
      });
    },
  });

  const removeGrant = useMutation({
    mutationFn: (input: { readonly role: Role; readonly permission: string }) =>
      api.tenancy.roleDefaultGrants.remove.mutate(input),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        removeGrant.mutate(input);
      });
    },
  });

  if (roleGrants.data === undefined) return null;

  const granted = new Set(roleGrants.data.map((entry) => `${entry.role}:${entry.permission}`));
  const permissions = [...GRANTABLE_PERMISSIONS];
  const pending = setGrant.isPending || removeGrant.isPending;

  return (
    <Section
      title="Role defaults"
      icon={<Settings2 aria-hidden="true" className="size-3.5" strokeWidth={2} />}
      count={roleGrants.data.length}
      description="What a new Member or Guest gets automatically, if an automation rule on 'Someone joins the organization' uses it — this list configures the bundle, it does not grant anything by itself."
    >
      <div className="flex flex-col gap-5">
        {CONFIGURABLE_ROLES.map((role) => (
          <div key={role} className="flex flex-col gap-2">
            <p className="text-xs font-medium capitalize text-ink">{role}</p>
            <div className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => {
                const checked = granted.has(`${role}:${permission}`);
                return (
                  <button
                    key={permission}
                    type="button"
                    disabled={!capabilities.manageMembers || pending}
                    aria-pressed={checked}
                    onClick={() => {
                      if (checked) removeGrant.mutate({ role, permission });
                      else setGrant.mutate({ role, permission });
                    }}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60',
                      checked
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-line/50 bg-surface text-ink-muted hover:bg-surface-hover',
                    )}
                  >
                    {permission}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {setGrant.isError && <ErrorText error={setGrant.error} />}
      {removeGrant.isError && <ErrorText error={removeGrant.error} />}
      {dialog}
    </Section>
  );
}

interface MemberRowProps {
  readonly member: {
    readonly userId: string;
    readonly email: string;
    readonly role: string;
    readonly status: string;
    readonly joinedAt: string;
  };
  readonly isSelf: boolean;
  readonly busy: boolean;
  /** member:manage — role changes are repeated per row; hide rather than show fifty disabled selects. */
  readonly canChangeRole: boolean;
  /** member:remove — same reasoning as canChangeRole. Also gates "Start
      offboarding" (§8), which shares the identical permission its own route
      floors on: flagging someone as leaving is a strictly smaller action
      than removing them outright. */
  readonly canRemove: boolean;
  /** Separate from `busy` — offboarding writes no visible state a shared
      "something is in flight" disable would need to protect, and coupling
      it to role-change/remove's own pending state would gray out the wrong
      button while a DIFFERENT mutation on the SAME row is running. */
  readonly offboardingBusy: boolean;
  readonly onRoleChange: (role: Role) => void;
  readonly onRemove: () => void;
  readonly onStartOffboarding: () => void;
}

function MemberRow({
  member,
  isSelf,
  busy,
  canChangeRole,
  canRemove,
  offboardingBusy,
  onRoleChange,
  onRemove,
  onStartOffboarding,
}: MemberRowProps) {
  return (
    <li className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-hover">
      <Avatar userId={member.userId} label={member.email} />

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm text-ink">
          {member.email}
          {isSelf && <span className="text-[11px] text-ink-faint">(you)</span>}
        </p>
        <p className="text-[11px] text-ink-faint">
          {member.status !== 'active' && <span className="mr-1 text-warning">{member.status}</span>}
          joined {formatDate(member.joinedAt)}
        </p>
      </div>

      {/* member:read (every role) still shows the role — only the ABILITY to
          change it is gated. A badge in place of the select when the viewer
          cannot act keeps the roster informative instead of hiding a fact
          nobody's permission was ever about. */}
      {canChangeRole ? (
        <select
          aria-label={`Role for ${member.email}`}
          value={member.role}
          disabled={busy}
          onChange={(event) => {
            onRoleChange(event.target.value as Role);
          }}
          className="h-7 rounded-lg border border-line/50 bg-surface-sunken px-1.5 text-xs text-ink"
        >
          {/* The CURRENT role is always present as an option even when it is not
              directly assignable — an owner's row would otherwise render showing
              "admin", which is a lie about who they are. */}
          {[...new Set<string>([member.role, ...DIRECTLY_ASSIGNABLE_ROLES])].map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      ) : (
        <Badge>{member.role}</Badge>
      )}

      {/* Revealed on hover, but always reachable by keyboard — `opacity-0` still
          takes focus, and `focus-visible:opacity-100` brings it back into view
          when it does. A control that only exists under a pointer is a control
          that does not exist for a keyboard. */}
      {canRemove && (
        <>
          {/* §8's own UI trigger. Plain, not `ConfirmButton` — unlike Remove
              this writes no column and cannot be gotten wrong in a way that
              needs a second click to confirm (`startOffboarding`'s own route
              comment: "nothing here is destructive or hard to undo"), and it
              is safe to click twice on purpose (idempotent — see
              `member.service.ts`). */}
          <Button
            variant="ghost"
            size="sm"
            disabled={offboardingBusy}
            onClick={onStartOffboarding}
            className="text-ink-muted opacity-0 hover:text-ink focus-visible:opacity-100 md:group-hover:opacity-100"
          >
            Start offboarding
          </Button>
          <ConfirmButton
            label="Remove"
            confirmLabel={`Remove ${member.email}`}
            disabled={busy}
            onConfirm={onRemove}
            className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
          />
        </>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- *
 * Teams
 * -------------------------------------------------------------------------- */

function TeamSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const teams = useQuery({
    queryKey: [...keys.org(orgId), 'teams'],
    queryFn: async () => wire(await api.tenancy.teams.list.query(undefined)),
  });

  const members = useQuery(membersQuery(orgId));
  // Same cache as OrgSection's query — team:read is every role's own, so the
  // roster below always renders; canManageTeams only gates create/add/remove.
  const org = useQuery(orgDetailQuery(orgId));
  const canManageTeams = org.data?.capabilities.manageTeams ?? false;
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...keys.org(orgId), 'teams'] });

  const create = useMutation({
    mutationFn: (value: string) =>
      api.tenancy.teams.create.mutate({ name: value, slug: slugify(value) }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });

  const addMember = useMutation({
    mutationFn: (input: { teamId: TeamId; userId: UserId }) =>
      api.tenancy.teams.addMember.mutate(input),
    onSuccess: refresh,
  });

  const removeMember = useMutation({
    mutationFn: (input: { teamId: TeamId; userId: UserId }) =>
      api.tenancy.teams.removeMember.mutate(input),
    onSuccess: refresh,
  });

  return (
    <Section
      title="Teams"
      icon={<UsersRound aria-hidden="true" className="size-3.5" strokeWidth={2} />}
      count={teams.data?.length}
      description="A team is a subject a grant can name. Adding someone to a team gives them everything that team has been granted, immediately — which is why it is an authorization change and is audited as one."
    >
      {/* Same reasoning as the member-invite form: a multi-field create form
          nobody without team:manage could submit is clutter, not signal. The
          roster below stays fully visible either way — team:read is every
          role's own. */}
      {canManageTeams && (
        <AddPanel>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== '') create.mutate(name.trim());
            }}
          >
            <div className="flex-1">
              <Field
                label="New team"
                htmlFor="team-name"
                hint={
                  name.trim() === ''
                    ? 'The address is derived from the name and must be unique.'
                    : `Address: ${slugify(name)}`
                }
              >
                <Input
                  id="team-name"
                  placeholder="Engineering"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending || name.trim() === ''}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
          </form>

          {create.isError && <ErrorText error={create.error} />}
        </AddPanel>
      )}

      {teams.isPending && <SkeletonRows rows={2} className="*:h-24" />}
      {teams.isError && <ErrorView error={teams.error} title="Could not load teams" />}

      {teams.data?.length === 0 && (
        <Empty
          title="No teams yet"
          description="Create one to grant access to a group at a time."
        />
      )}

      <ul className="space-y-2">
        {(teams.data ?? []).map((team) => (
          <TeamCard
            key={team.teamId}
            team={team}
            orgMembers={members.data ?? []}
            canManage={canManageTeams}
            onAdd={(userId) => {
              addMember.mutate({ teamId: team.teamId as TeamId, userId });
            }}
            onRemove={(userId) => {
              removeMember.mutate({ teamId: team.teamId as TeamId, userId });
            }}
            busy={addMember.isPending || removeMember.isPending}
          />
        ))}
      </ul>

      {addMember.isError && <ErrorText error={addMember.error} />}
      {removeMember.isError && <ErrorText error={removeMember.error} />}
    </Section>
  );
}

interface TeamCardProps {
  readonly team: {
    readonly teamId: string;
    readonly name: string;
    readonly slug: string;
    readonly members: readonly { readonly userId: string; readonly email: string }[];
  };
  readonly orgMembers: readonly { readonly userId: string; readonly email: string }[];
  /** team:manage — gates the add picker and every roster chip's remove control. */
  readonly canManage: boolean;
  readonly onAdd: (userId: UserId) => void;
  readonly onRemove: (userId: UserId) => void;
  readonly busy: boolean;
}

/**
 * One team, with its roster.
 *
 * The version this replaced had two dropdowns — "Add member…" and "Remove
 * member…" — both listing every member of the ORG, because the list route
 * returned a count and not the roster. Three things were wrong with it, and they
 * are what the layout below is shaped around:
 *
 *   - You could not see who was on the team. The only feedback was a number.
 *   - "Remove" offered people who were never on the team, and each of those
 *     picks was a guaranteed 404.
 *   - "Add" offered people already on it, where the service correctly does
 *     nothing — a control that reports success and changes nothing.
 *
 * So membership is now shown as the thing it is, a list of people, and each
 * removal happens on the row of the person being removed. The add picker lists
 * only candidates: an empty picker means everyone is already here, which is a
 * fact worth rendering rather than a dropdown that silently does nothing.
 */
function TeamCard({ team, orgMembers, canManage, onAdd, onRemove, busy }: TeamCardProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  const onTeam = new Set(team.members.map((member) => member.userId));
  const candidates = orgMembers.filter((member) => !onTeam.has(member.userId));

  return (
    <li className="rounded-xl border border-line/50 bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{team.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">{team.slug}</span>
        <Badge className="ml-auto">
          {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
        </Badge>
      </div>

      {/* Add first, then the roster — the same order as every other section.
          Hidden rather than a disabled dropdown of every org member, which
          would be noisy on every one of potentially many team cards. */}
      {canManage && (
        <div className="mt-2.5">
          {candidates.length === 0 ? (
            <p className="text-[11px] text-ink-faint">
              {orgMembers.length === 0
                ? 'No org members to add.'
                : 'Everyone in the organization is on this team.'}
            </p>
          ) : (
            <TeamAddPicker teamName={team.name} candidates={candidates} busy={busy} onAdd={onAdd} />
          )}
        </div>
      )}

      {team.members.length === 0 ? (
        <p className="mt-2.5 text-xs text-ink-faint">
          Nobody on this team yet. A grant naming it currently reaches no one.
        </p>
      ) : (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {team.members.map((member) => {
            const isConfirming = confirming === member.userId;
            return (
              <li
                key={member.userId}
                className={cn(
                  'group flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-1',
                  isConfirming ? 'border-danger/40 bg-danger/10' : 'border-line bg-surface-sunken',
                )}
              >
                <Avatar userId={member.userId} label={member.email} size="xs" />
                <span className="text-xs text-ink">{member.email}</span>

                {/* Chip-per-member removal, gated the same way the add picker
                    above is: hidden rather than a disabled × on every chip of
                    every team a viewer without team:manage can see. */}
                {canManage &&
                  (isConfirming ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onRemove(member.userId as UserId);
                          setConfirming(null);
                        }}
                        className="rounded-full px-1.5 text-[11px] font-medium text-danger hover:underline"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(null);
                        }}
                        className="rounded-full px-1 text-[11px] text-ink-muted hover:underline"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    /* Two clicks, not a window.confirm: removing someone from a
                       team is an authorization change that takes effect
                       immediately, and a single stray click on a chip is too cheap
                       for that. The confirm is inline so it cannot be dismissed by
                       clicking the wrong thing. */
                    <button
                      type="button"
                      aria-label={`Remove ${member.email} from ${team.name}`}
                      onClick={() => {
                        setConfirming(member.userId);
                      }}
                      className={cn(
                        'flex size-4 items-center justify-center rounded-full text-ink-faint',
                        'hover:bg-danger/15 hover:text-danger',
                        'focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100',
                      )}
                    >
                      <span aria-hidden="true">&times;</span>
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * The "Add member" control for one team card, as a searchable popover rather
 * than a native `<select>` — the same shape `PermissionsSection`'s own member
 * picker already uses a few hundred lines up in this file, applied here for
 * the identical reason: a plain `<select>` scales to a scrollable native
 * dropdown with no way to type past the first few candidates, where a real
 * org can hold far more members than a picker like this should ask someone
 * to scroll through by eye.
 */
function TeamAddPicker({
  teamName,
  candidates,
  busy,
  onAdd,
}: {
  readonly teamName: string;
  readonly candidates: readonly { readonly userId: string; readonly email: string }[];
  readonly busy: boolean;
  readonly onAdd: (userId: UserId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = candidates.filter((member) => member.email.toLowerCase().includes(needle));

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Add someone to ${teamName}`}
          className="flex h-8 w-full items-center rounded-lg border border-line/50 bg-surface-sunken px-2 text-left text-xs text-ink-muted transition-colors hover:border-line hover:text-ink"
        >
          Add member…
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-1.5 p-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search by email…"
          className="h-8"
        />
        {matches.length === 0 ? (
          <p className="p-1 text-xs text-ink-faint">No matches.</p>
        ) : (
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {matches.map((member) => (
              <li key={member.userId}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onAdd(member.userId as UserId);
                    setOpen(false);
                    setQuery('');
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  <Avatar userId={member.userId} label={member.email} size="xs" />
                  <span className="truncate">{member.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
