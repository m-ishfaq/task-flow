import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectId, UserId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { formatDate } from '../../lib/format.js';
import { Button, Empty, Field, Input, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import { projectGuestsQuery } from './api.js';

/**
 * Guest access into Work — one door, not two.
 *
 * Originally required an admin to add someone as a Guest-role member of the
 * ORG first (via the generic Members section), then come back HERE to grant
 * project access — a real, reported gap for anyone with no TaskFlow account
 * yet, who had no path through this at all. `work.guests.inviteByEmail` (see
 * `apps/api/src/work/guest-access.service.ts`'s "One door, not two" header)
 * collapsed that into one email box: the server decides whether to grant
 * immediately (an existing Guest-role member of this org) or send a real,
 * mailed invitation that grants itself automatically the instant it is
 * accepted — either way, this form only ever asks for an email and a
 * relation.
 */

/**
 * Narrower than `@taskflow/policy`'s `Relation` — `work.guests.inviteByEmail`'s
 * own Zod schema is `z.enum(['viewer', 'commenter', 'editor'])`, never
 * `owner` or `member`, so the picker offers only what the server will
 * accept.
 */
type GuestRelation = 'viewer' | 'commenter' | 'editor';

const GUEST_RELATIONS: readonly GuestRelation[] = ['viewer', 'commenter', 'editor'];

export function GuestAccessSection({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const guests = useQuery(projectGuestsQuery(orgId, projectId));
  const [email, setEmail] = useState('');
  const [relation, setRelation] = useState<GuestRelation>('viewer');

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.projectGuests(orgId, projectId) });

  const invite = useMutation({
    mutationFn: () =>
      api.work.guests.inviteByEmail.mutate({ projectId, email, relation, expiresAt: null }),
    onSuccess: (result) => {
      setEmail('');
      if (result.status === 'granted') {
        toast.show('Access granted — they can already see this project.');
      } else {
        toast.show(`Invitation sent to ${email} — access starts the moment they accept.`);
      }
      return refresh();
    },
    onError: (error) => {
      toast.failure('They were not invited', error);
    },
  });

  const revoke = useMutation({
    mutationFn: (userId: UserId) => api.work.guests.revoke.mutate({ projectId, userId }),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('Access was not revoked', error);
    },
  });

  return (
    <Section
      title="Guest access"
      count={guests.data?.length}
      description="Loop in an external collaborator on this project alone, without giving them the rest of the organization. Type their email below — if they already have an account, access starts right away; if not, they'll get an invitation, and access begins the moment they accept it."
    >
      {guests.isPending && <SkeletonRows rows={2} className="*:h-10" />}

      {guests.data?.length === 0 ? (
        <Empty
          title="No guests invited yet"
          description="Invite someone below. They'll see this project and everything under it, and nothing else in the organization."
        />
      ) : (
        <ul className="divide-y divide-line/40 rounded border border-line/50">
          {(guests.data ?? []).map((row) => (
            <li key={row.tupleId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{row.displayName ?? row.email}</p>
                <p className="text-xs text-ink-faint">
                  {row.relation}
                  {row.expiresAt !== null && ` · expires ${formatDate(row.expiresAt)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                disabled={revoke.isPending}
                onClick={() => {
                  revoke.mutate(row.userId as UserId);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (email.trim() === '') return;
          invite.mutate();
        }}
      >
        <Field label="Invite a guest by email" htmlFor={`project-guest-invite-${projectId}`}>
          <Input
            id={`project-guest-invite-${projectId}`}
            type="email"
            value={email}
            placeholder="name@example.com"
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>

        <select
          aria-label="Relation"
          value={relation}
          onChange={(event) => {
            setRelation(event.target.value as GuestRelation);
          }}
          className="h-8 rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          {GUEST_RELATIONS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>

        <Button type="submit" size="sm" disabled={invite.isPending || email.trim() === ''}>
          {invite.isPending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>

      {invite.isError && <ErrorText error={invite.error} />}
      {revoke.isError && <ErrorText error={revoke.error} />}
    </Section>
  );
}
