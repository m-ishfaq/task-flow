import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import type { TeamId, UserId } from '@taskflow/contracts';
import { DIRECTLY_ASSIGNABLE_ROLES, type Role } from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { wire } from '../../lib/wire.js';
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
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useStepUp } from '../auth/use-step-up.js';
import { membersQuery } from '../org/api.js';
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
    <div className="mx-auto flex max-w-3xl flex-col gap-10 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Organization settings</h1>
          <p className="text-xs text-ink-muted">Members, teams, and who can reach what.</p>
        </div>
        <Link
          to="/settings/audit"
          className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          Audit log
        </Link>
      </div>

      <OrgSection orgId={orgId} />
      <BillingSection orgId={orgId} />
      <MemberSection orgId={orgId} />
      <TeamSection orgId={orgId} />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * The organization
 * -------------------------------------------------------------------------- */

function OrgSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();

  const org = useQuery({
    queryKey: [...keys.org(orgId), 'detail'],
    queryFn: async () => wire(await api.tenancy.orgs.get.query(undefined)),
  });

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

  return (
    <Section title="Organization">
      <div className="rounded-lg border border-line bg-surface-raised p-3">
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
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={rename.isPending || current === org.data.name}
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
  const { guard, dialog } = useStepUp();
  const currentUserId = useSession((state) => state.userId);

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

  return (
    <Section
      title="Members"
      count={members.data?.length}
      description="Everyone with access to this organization. A role decides what they can do across it; a team grant can narrow or widen that on one resource."
    >
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
              hint="The person must already have a TaskFlow account — email invitations arrive in a later phase."
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
            className="h-9 rounded border border-line bg-surface px-2 text-sm text-ink"
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

      {/* Rendered for everyone — see the transfer comment above on why the
          role check is the server's, not this button's. */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={transferCandidates.length === 0}
          title={
            transferCandidates.length === 0 ? 'There is nobody else to transfer to yet.' : undefined
          }
          onClick={openTransfer}
          className="text-ink-muted hover:text-ink"
        >
          Transfer ownership…
        </Button>
      </div>

      {members.isPending && <SkeletonRows rows={4} className="*:h-12" />}
      {members.isError && <ErrorView error={members.error} title="Could not load members" />}

      {members.data !== undefined && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {members.data.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              isSelf={member.userId === currentUserId}
              busy={changeRole.isPending || remove.isPending}
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
                  className="h-9 w-full rounded border border-line bg-surface px-2 text-sm text-ink"
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
                  className="h-9 w-full rounded border border-line bg-surface px-2 text-sm text-ink"
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
  readonly onRoleChange: (role: Role) => void;
  readonly onRemove: () => void;
}

function MemberRow({ member, isSelf, busy, onRoleChange, onRemove }: MemberRowProps) {
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

      <select
        aria-label={`Role for ${member.email}`}
        value={member.role}
        disabled={busy}
        onChange={(event) => {
          onRoleChange(event.target.value as Role);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
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

      {/* Revealed on hover, but always reachable by keyboard — `opacity-0` still
          takes focus, and `focus-visible:opacity-100` brings it back into view
          when it does. A control that only exists under a pointer is a control
          that does not exist for a keyboard. */}
      <ConfirmButton
        label="Remove"
        confirmLabel={`Remove ${member.email}`}
        disabled={busy}
        onConfirm={onRemove}
        className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
      />
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
          <Button type="submit" variant="primary" disabled={create.isPending || name.trim() === ''}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </form>

        {create.isError && <ErrorText error={create.error} />}
      </AddPanel>

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
function TeamCard({ team, orgMembers, onAdd, onRemove, busy }: TeamCardProps) {
  const [confirming, setConfirming] = useState<string | null>(null);

  const onTeam = new Set(team.members.map((member) => member.userId));
  const candidates = orgMembers.filter((member) => !onTeam.has(member.userId));

  return (
    <li className="rounded-lg border border-line bg-surface-raised p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{team.name}</span>
        <span className="font-mono text-[11px] text-ink-faint">{team.slug}</span>
        <Badge className="ml-auto">
          {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
        </Badge>
      </div>

      {/* Add first, then the roster — the same order as every other section. */}
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
            className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
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

                {isConfirming ? (
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
                )}
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
