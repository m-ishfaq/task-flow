import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { TeamId, UserId } from '@taskflow/contracts';
import { DIRECTLY_ASSIGNABLE_ROLES, type Role } from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { wire } from '../../lib/wire.js';
import { formatDate } from '../../lib/format.js';
import { Button, Empty, Field, Input, Spinner } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { useStepUp } from '../auth/use-step-up.js';
import { membersQuery } from '../org/api.js';

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
 */
export function SettingsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Organization settings</h1>
        <Link to="/settings/audit" className="text-sm text-accent underline">
          Audit log
        </Link>
      </div>

      <OrgSection orgId={orgId} />
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
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Organization</h2>

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

      <p className="text-xs text-ink-faint">
        Slug <span className="font-mono">{org.data.slug}</span> · created{' '}
        {formatDate(org.data.createdAt)}. The slug is fixed — it appears in links that already
        exist.
      </p>

      {rename.isError && <ErrorText error={rename.error} />}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Members
 * -------------------------------------------------------------------------- */

function MemberSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(orgId));
  const { guard, dialog } = useStepUp();

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

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Members</h2>

      {members.isPending && <Spinner />}
      {members.isError && <ErrorView error={members.error} title="Could not load members" />}

      {members.data !== undefined && (
        <ul className="divide-y divide-line rounded border border-line">
          {members.data.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{member.email}</p>
                <p className="text-[11px] text-ink-faint">
                  {member.status} · joined {formatDate(member.joinedAt)}
                </p>
              </div>

              <select
                aria-label={`Role for ${member.email}`}
                value={member.role}
                onChange={(event) => {
                  changeRole.mutate({
                    userId: member.userId as UserId,
                    role: event.target.value as Role,
                  });
                }}
                className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
              >
                {/* The CURRENT role is always present as an option even when it
                    is not directly assignable — an owner's row would otherwise
                    render showing "admin", which is a lie about who they are. */}
                {[...new Set<string>([member.role, ...DIRECTLY_ASSIGNABLE_ROLES])].map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>

              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  remove.mutate(member.userId as UserId);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (email.trim() !== '') add.mutate({ email: email.trim(), role });
        }}
      >
        <div className="flex-1">
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
          aria-label="Role"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as Role);
          }}
          className="h-9 rounded border border-line bg-surface-sunken px-2 text-sm text-ink"
        >
          {DIRECTLY_ASSIGNABLE_ROLES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>

        <Button type="submit" variant="primary" disabled={add.isPending}>
          Add
        </Button>
      </form>

      {add.isError && <ErrorText error={add.error} />}
      {changeRole.isError && <ErrorText error={changeRole.error} />}
      {remove.isError && <ErrorText error={remove.error} />}

      {dialog}
    </section>
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
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Teams</h2>
      <p className="text-xs text-ink-muted">
        A team is a subject a grant can name. Adding someone to a team gives them everything that
        team has been granted, immediately — which is why it is an authorization change and is
        audited as one.
      </p>

      {teams.data?.length === 0 && (
        <Empty
          title="No teams yet"
          description="Create one to grant access to a group at a time."
        />
      )}

      <ul className="space-y-2">
        {(teams.data ?? []).map((team) => (
          <li key={team.teamId} className="rounded border border-line p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-ink">{team.name}</span>
              <span className="font-mono text-[11px] text-ink-faint">{team.slug}</span>
              <span className="ml-auto text-[11px] text-ink-faint">
                {team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <select
                aria-label={`Add someone to ${team.name}`}
                defaultValue=""
                onChange={(event) => {
                  const userId = event.target.value;
                  if (userId === '') return;
                  addMember.mutate({ teamId: team.teamId as TeamId, userId: userId as UserId });
                  event.currentTarget.value = '';
                }}
                className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
              >
                <option value="">Add member…</option>
                {(members.data ?? []).map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email}
                  </option>
                ))}
              </select>

              {/* `teams.list` returns a COUNT, not the roster, so removal takes
                  the same member picker. Listing a team's members needs a route
                  that does not exist yet — noted rather than faked. */}
              <select
                aria-label={`Remove someone from ${team.name}`}
                defaultValue=""
                onChange={(event) => {
                  const userId = event.target.value;
                  if (userId === '') return;
                  removeMember.mutate({ teamId: team.teamId as TeamId, userId: userId as UserId });
                  event.currentTarget.value = '';
                }}
                className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
              >
                <option value="">Remove member…</option>
                {(members.data ?? []).map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.email}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') create.mutate(name.trim());
        }}
      >
        <div className="flex-1">
          <Field label="New team" htmlFor="team-name">
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
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Create
        </Button>
      </form>

      {create.isError && <ErrorText error={create.error} />}
      {addMember.isError && <ErrorText error={addMember.error} />}
      {removeMember.isError && <ErrorText error={removeMember.error} />}
    </section>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
