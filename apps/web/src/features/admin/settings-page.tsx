import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
import { DIRECTLY_ASSIGNABLE_ROLES, GRANTABLE_PERMISSIONS, type Role } from '@taskflow/policy';
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
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useBranding } from '../../lib/branding-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import {
  membersQuery,
  memberGrantsQuery,
  orgDetailQuery,
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
export function SettingsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-9 p-8">
      <PageHeader
        title="Organization settings"
        description="Members, teams, and who can reach what."
        actions={
          <Link
            to="/settings/audit"
            className="rounded-lg border border-line/50 px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            Audit log
          </Link>
        }
      />

      <OrgSection orgId={orgId} />
      <BillingSection orgId={orgId} />
      <MemberSection orgId={orgId} />
      <PermissionsSection orgId={orgId} />
      <TeamSection orgId={orgId} />
    </div>
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
    <Section title="Organization">
      <div className="rounded-lg border border-line/50 bg-surface-raised p-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (current.trim() !== '' && current !== org.data.name) rename.mutate(current.trim());
          }}
        >
          <div className="flex-1">
            <Field label="Name" htmlFor="org-name">
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
          Slug <span className="font-mono text-ink-muted">{org.data.slug}</span> · created{' '}
          {formatDate(org.data.createdAt)}. The slug is fixed — it appears in links that already
          exist.
        </p>
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
  const org = useQuery(orgDetailQuery(orgId));
  const { guard, dialog } = useStepUp();
  const currentUserId = useSession((state) => state.userId);
  const { productName } = useBranding();

  /* Same cache as OrgSection's own query (identical key), so this costs no
     extra request — React Query dedupes by key. Undefined only while the
     very first load of the page is still in flight; every control below
     defaults to hidden/disabled until it resolves, never the other way. */
  const capabilities: SettingsCapabilities = org.data?.capabilities ?? {
    updateOrg: false,
    inviteMember: false,
    manageMembers: false,
    removeMembers: false,
    manageTeams: false,
    createProject: false,
    viewAnalytics: false,
    viewAutomations: false,
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.members(orgId) });

  const add = useMutation({
    mutationFn: (input: { email: string; role: Role }) => api.tenancy.members.add.mutate(input),
    onSuccess: refresh,
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
              if (email.trim() !== '') add.mutate({ email: email.trim(), role });
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field
                label="Add a member"
                htmlFor="member-email"
                hint={`The person must already have a ${productName} account — email invitations arrive in a later phase.`}
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

            <Button type="submit" variant="primary" disabled={add.isPending || email.trim() === ''}>
              {add.isPending ? 'Adding…' : 'Add'}
            </Button>
          </form>

          {add.isError && <ErrorText error={add.error} />}
        </AddPanel>
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
            <Input
              aria-label="Search members"
              placeholder="Search by name or email…"
              value={memberSearch}
              onChange={(event) => {
                setMemberSearch(event.target.value);
              }}
              className="mb-2 h-9 max-w-xs text-sm"
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
                  onRoleChange={(next) => {
                    changeRole.mutate({ userId: member.userId as UserId, role: next });
                  }}
                  onRemove={() => {
                    remove.mutate(member.userId as UserId);
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
 * above uses: a form to grant one permission to one person, and a list of
 * only the grants that actually exist. It grows with usage, not with
 * headcount × catalog size.
 *
 * The member picker is the same type-to-filter Popover list
 * `assignee-section.tsx` and `card-tile.tsx`'s `QuickAssignee` already use —
 * this is a further occurrence of that pattern, not a new one; see that
 * file's own note on pulling it into a shared component once a good moment
 * presents itself, not forced here.
 *
 * The grant list itself is visible to anyone who can see the Members section
 * above (both routes sit behind `member:read`) — only the add form and the
 * revoke buttons are hidden for a caller without `member:manage`, matching
 * how the invite form above is hidden rather than shown-and-disabled.
 */
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
    removeMembers: false,
    manageTeams: false,
    createProject: false,
    viewAnalytics: false,
    viewAutomations: false,
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.memberGrants(orgId) });

  const grant = useMutation({
    mutationFn: (input: { userId: UserId; permission: string }) =>
      api.tenancy.memberGrants.grant.mutate(input),
    onSuccess: async () => {
      setPickedUserId('');
      setMemberQuery('');
      await refresh();
    },
    onError: (error, input) => {
      guard(error, () => {
        grant.mutate(input);
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

  const permissions = [...GRANTABLE_PERMISSIONS];

  const [pickedUserId, setPickedUserId] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [permission, setPermission] = useState<string>(permissions[0] ?? '');

  const [grantSearch, setGrantSearch] = useState('');

  if (members.data === undefined || grants.data === undefined) return null;

  const labelOf = (member: { readonly email: string; readonly displayName: string | null }) =>
    member.displayName ?? member.email;

  const memberById = new Map(members.data.map((member) => [member.userId, member]));
  const pickedMember = memberById.get(pickedUserId);

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

  return (
    <Section
      title="Individual permissions"
      count={grants.data.length}
      description="On top of a member's role, one specific ability can be given to (or taken from) one person — e.g. letting one guest place calls without promoting them to Member."
    >
      {capabilities.manageMembers && permissions.length > 0 && (
        <AddPanel>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (pickedUserId !== '' && permission !== '') {
                grant.mutate({ userId: pickedUserId as UserId, permission });
              }
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field label="Member" htmlFor="grant-member-search">
                <PopoverRoot
                  open={pickerOpen}
                  onOpenChange={(open) => {
                    setPickerOpen(open);
                    if (!open) setMemberQuery('');
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      id="grant-member-search"
                      className="flex h-9 w-full items-center rounded-lg border border-line/50 bg-surface px-2 text-left text-sm text-ink"
                    >
                      {pickedMember ? (
                        <span className="flex items-center gap-1.5 truncate">
                          <Avatar
                            userId={pickedMember.userId}
                            label={labelOf(pickedMember)}
                            size="xs"
                          />
                          <span className="truncate">{labelOf(pickedMember)}</span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">Search by name or email…</span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 space-y-1.5 p-2">
                    <Input
                      aria-label="Search members"
                      placeholder="Search by name or email…"
                      value={memberQuery}
                      onChange={(event) => {
                        setMemberQuery(event.target.value);
                      }}
                      className="h-8 text-xs"
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
                                setPickedUserId(member.userId);
                                setPickerOpen(false);
                                setMemberQuery('');
                              }}
                              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                            >
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
              </Field>
            </div>

            <select
              aria-label="Permission to grant"
              value={permission}
              onChange={(event) => {
                setPermission(event.target.value);
              }}
              className="h-9 rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
            >
              {permissions.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>

            <Button
              type="submit"
              variant="primary"
              disabled={grant.isPending || pickedUserId === ''}
            >
              {grant.isPending ? 'Granting…' : 'Grant'}
            </Button>
          </form>

          {grant.isError && <ErrorText error={grant.error} />}
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

          {visibleGrants.length === 0 ? (
            <Empty title="No grants match your search" />
          ) : (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-xl border border-line/50">
              {visibleGrants.map((entry) => {
                const member = memberById.get(entry.userId);
                return (
                  <li
                    key={`${entry.userId}:${entry.permission}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <Avatar userId={entry.userId} label={member ? labelOf(member) : entry.userId} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">
                        {member ? labelOf(member) : entry.userId}
                      </div>
                      <div className="text-xs text-ink-faint">
                        {member?.role ?? 'former member'} · granted {formatDate(entry.grantedAt)}
                      </div>
                    </div>
                    <Badge>{entry.permission}</Badge>
                    {capabilities.manageMembers && (
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Revoke?"
                        size="sm"
                        disabled={revoke.isPending}
                        onConfirm={() => {
                          revoke.mutate({
                            userId: entry.userId as UserId,
                            permission: entry.permission,
                          });
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {revoke.isError && <ErrorText error={revoke.error} />}
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
  /** member:remove — same reasoning as canChangeRole. */
  readonly canRemove: boolean;
  readonly onRoleChange: (role: Role) => void;
  readonly onRemove: () => void;
}

function MemberRow({
  member,
  isSelf,
  busy,
  canChangeRole,
  canRemove,
  onRoleChange,
  onRemove,
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
        <ConfirmButton
          label="Remove"
          confirmLabel={`Remove ${member.email}`}
          disabled={busy}
          onConfirm={onRemove}
          className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        />
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
            <select
              aria-label={`Add someone to ${team.name}`}
              value=""
              disabled={busy}
              onChange={(event) => {
                const userId = event.target.value;
                if (userId === '') return;
                onAdd(userId as UserId);
              }}
              className="h-8 w-full rounded-lg border border-line/50 bg-surface-sunken px-2 text-xs text-ink"
            >
              <option value="">Add member…</option>
              {candidates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.email}
                </option>
              ))}
            </select>
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
