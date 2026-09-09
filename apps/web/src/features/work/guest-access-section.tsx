import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectId, UserId } from '@taskflow/contracts';
import { isGuestRole } from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { formatDate } from '../../lib/format.js';
import { Button, Empty, Field, Input, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import { membersQuery } from '../org/api.js';
import { projectGuestsQuery } from './api.js';

/**
 * Guest access into Work — a dedicated invite flow, separate from
 * `share-board.tsx`'s generic Share dialog, mirroring `channel-details.tsx`'s
 * `GuestAccessSection` for chat channels one level up (a project rather than
 * a channel).
 *
 * ## Restricted to members already holding the Guest role
 *
 * `share-board.tsx` can share a board with ANY member; this can only invite
 * someone whose org-level role is already Guest — `work.guests.invite`
 * refuses anyone else with a validation error naming the Share dialog
 * instead. So the candidate list below is filtered client-side to the same
 * standard the server enforces, purely so a caller never sees an option that
 * would just be refused: the real check still happens on the server.
 */

/**
 * Narrower than `@taskflow/policy`'s `Relation` — `work.guests.invite`'s own
 * Zod schema is `z.enum(['viewer', 'commenter', 'editor'])`, never `owner`
 * or `member`, so the picker offers only what the server will accept.
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
  const members = useQuery(membersQuery(orgId));
  const guests = useQuery(projectGuestsQuery(orgId, projectId));
  const [query, setQuery] = useState('');
  const [relation, setRelation] = useState<GuestRelation>('viewer');

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.projectGuests(orgId, projectId) });

  const invite = useMutation({
    mutationFn: (userId: UserId) =>
      api.work.guests.invite.mutate({ projectId, userId, relation, expiresAt: null }),
    onSuccess: () => {
      setQuery('');
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

  const guestIds = new Set((guests.data ?? []).map((row) => row.userId));
  const needle = query.trim().toLowerCase();
  const candidates = (members.data ?? [])
    .filter((member) => isGuestRole(member.role))
    .filter((member) => !guestIds.has(member.userId))
    .filter((member) => needle === '' || member.email.toLowerCase().includes(needle))
    .slice(0, 8);

  return (
    <Section
      title="Guest access"
      count={guests.data?.length}
      description="Loop in an external collaborator on this project alone, without giving them the rest of the organization. Only members with the Guest role can be invited here — add them as a Guest from the Members section first."
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
                <p className="text-[11px] text-ink-faint">
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

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Invite a guest by email" htmlFor={`project-guest-invite-${projectId}`}>
          <Input
            id={`project-guest-invite-${projectId}`}
            value={query}
            placeholder="name@example.com"
            onChange={(event) => {
              setQuery(event.target.value);
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
      </div>

      {needle !== '' &&
        (candidates.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">
            No Guest-role member matches. Add them as a Guest from the Members section first.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {candidates.map((member) => (
              <li key={member.userId}>
                <button
                  type="button"
                  disabled={invite.isPending}
                  onClick={() => {
                    invite.mutate(member.userId as UserId);
                  }}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-surface-hover disabled:opacity-50"
                >
                  <span className="truncate text-ink">{member.displayName ?? member.email}</span>
                  <span className="shrink-0 text-ink-faint">Invite as {relation}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {invite.isError && <ErrorText error={invite.error} />}
      {revoke.isError && <ErrorText error={revoke.error} />}
    </Section>
  );
}
