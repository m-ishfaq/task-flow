import { useState } from 'react';
import {
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalRoot,
  ModalTitle,
  ModalTrigger,
} from '@taskflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import {
  RELATIONS,
  isRelation,
  isRestrictive,
  permissionsForRelation,
  type Relation,
} from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button, Empty } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { useStepUp } from '../auth/use-step-up.js';
import { membersQuery } from '../org/api.js';

/**
 * Sharing a board with a person or a team — relationship tuples (§8.2).
 *
 * This is the Zanzibar-lite half of the permission model, and the half that has
 * no other way in: a role says what a member may do ACROSS the org, a tuple says
 * what one subject may do to ONE resource. Without this dialog the whole
 * relation system was unreachable, so a board could only ever be as private as
 * the org itself.
 *
 * ## Restrictive relations are labelled as such
 *
 * Some relations GRANT and some CAP. `isRestrictive` is the policy package's own
 * answer, not a list retyped here — a `viewer` tuple on a board caps what an
 * admin may do to it, which is the opposite of what "share" usually implies, and
 * a picker that presented both identically would let someone hand out a
 * restriction believing they were granting access.
 *
 * Writing a tuple is step-up authenticated: it changes who can reach data, which
 * is exactly what a stolen session would be used for.
 */

export interface ShareBoardProps {
  readonly orgId: string;
  readonly boardId: BoardId;
}

export function ShareBoardDialog({ orgId, boardId }: ShareBoardProps) {
  const [open, setOpen] = useState(false);

  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button size="sm">Share</Button>
      </ModalTrigger>
      <ModalContent size="lg" className="max-h-[85vh] overflow-y-auto p-4">
        <ModalTitle>Share this board</ModalTitle>
        <ModalDescription>
          Grants apply to this board alone, on top of whatever the person&rsquo;s org role already
          allows.
        </ModalDescription>

        <ShareBody orgId={orgId} boardId={boardId} />

        <div className="mt-4 flex justify-end">
          <ModalClose asChild>
            <Button>Done</Button>
          </ModalClose>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

function ShareBody({ orgId, boardId }: ShareBoardProps) {
  const queryClient = useQueryClient();
  const members = useQuery(membersQuery(orgId));
  const { guard, dialog } = useStepUp();

  const grantsKey = [...keys.org(orgId), 'grants', 'board', boardId];

  const grants = useQuery({
    queryKey: grantsKey,
    queryFn: async () =>
      wire(await api.tenancy.grants.list.query({ objectType: 'board', objectId: boardId })),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: grantsKey });

  const [subjectId, setSubjectId] = useState('');
  const [relation, setRelation] = useState<Relation>(RELATIONS[0]);

  const grant = useMutation({
    mutationFn: (input: { subjectId: string; relation: Relation }) =>
      api.tenancy.grants.grant.mutate({
        subjectType: 'user',
        subjectId: input.subjectId,
        relation: input.relation,
        objectType: 'board',
        objectId: boardId,
        expiresAt: null,
      }),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        grant.mutate(input);
      });
    },
  });

  const revoke = useMutation({
    mutationFn: (tupleId: string) => api.tenancy.grants.revoke.mutate({ tupleId }),
    onSuccess: refresh,
    onError: (error, tupleId) => {
      guard(error, () => {
        revoke.mutate(tupleId);
      });
    },
  });

  const emailOf = (userId: string) =>
    members.data?.find((member) => member.userId === userId)?.email ?? userId;

  return (
    <div className="mt-4 space-y-4">
      {grants.data?.length === 0 ? (
        <Empty title="Not shared with anyone yet" />
      ) : (
        <ul className="divide-y divide-line/40 rounded border border-line/50">
          {(grants.data ?? []).map((tuple) => (
            <li key={tuple.tupleId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {tuple.subjectType === 'user' ? emailOf(tuple.subjectId) : tuple.subjectId}
                </p>
                <p className="text-xs text-ink-faint">
                  {tuple.subjectType} · {tuple.relation}
                  {/* Narrowed first: `grants.list` types `relation` as a plain
                      string, because the column is text and a tuple written by
                      an older build could name a relation this one has never
                      heard of. Asking the policy package about it directly would
                      be trusting a database value to be a member of a union. */}
                  {isRelation(tuple.relation) && isRestrictive(tuple.relation) && (
                    <span className="ml-1 text-warning">(caps access rather than granting it)</span>
                  )}
                  {tuple.expiresAt !== null && ` · expires ${formatDate(tuple.expiresAt)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={() => {
                  revoke.mutate(tuple.tupleId);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (subjectId !== '') grant.mutate({ subjectId, relation });
        }}
      >
        <select
          aria-label="Person"
          value={subjectId}
          onChange={(event) => {
            setSubjectId(event.target.value);
          }}
          className="h-8 flex-1 rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          <option value="">Choose someone…</option>
          {(members.data ?? []).map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.email}
            </option>
          ))}
        </select>

        <select
          aria-label="Relation"
          value={relation}
          onChange={(event) => {
            setRelation(event.target.value as Relation);
          }}
          className="h-8 rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          {RELATIONS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
              {isRestrictive(entry) ? ' (restrictive)' : ''}
            </option>
          ))}
        </select>

        <Button type="submit" size="sm" variant="primary" disabled={grant.isPending}>
          Grant
        </Button>
      </form>

      {/* Shows what the chosen relation actually confers, read from the policy
          package. A relation name alone is not self-explanatory, and guessing
          wrong here hands out real access. */}
      <p className="text-xs text-ink-faint">
        <span className="font-medium">{relation}</span> confers:{' '}
        {permissionsForRelation(relation).join(', ') || 'nothing on its own'}
      </p>

      {grant.isError && <ErrorText error={grant.error} />}
      {revoke.isError && <ErrorText error={revoke.error} />}

      {dialog}
    </div>
  );
}
