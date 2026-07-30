import { useMutation, useQuery } from '@tanstack/react-query';
import type { BoardId, CardId, UserId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { cn } from '../../../lib/cn.js';
import { Avatar } from '../../../components/primitives.js';
import { membersQuery } from '../../org/api.js';
import { patchBoardCards, patchCardDetail } from '../api.js';

/**
 * Who a card is assigned to.
 *
 * Sends the WHOLE SET rather than an add/remove delta, matching `assignCard` on
 * the server and for the same reason as labels: two people editing assignees
 * concurrently with deltas converge on a set neither of them chose, whereas the
 * intended set means the last writer wins something a human actually asked for.
 *
 * The member list comes from `tenancy.members.list`, which needs `member:read` —
 * so a member without it sees no picker and the server would refuse the write
 * anyway. Nothing here re-derives that; the query simply returns nothing.
 */

export interface AssigneeSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly assigneeIds: readonly string[];
}

export function AssigneeSection({ orgId, boardId, cardId, assigneeIds }: AssigneeSectionProps) {
  const optimistic = useOptimistic();
  const members = useQuery(membersQuery(orgId));

  const assign = useMutation({
    mutationFn: (ids: readonly string[]) =>
      api.work.cards.assign.mutate({ cardId, assigneeIds: ids as UserId[] }),

    /* Both keys, because the avatars appear in two places: the detail panel this
       control lives in and the card tile behind it. Patching only the detail
       entry leaves the tile showing the old set until the invalidation lands,
       which is the flicker the optimism was meant to remove. */
    ...optimistic<readonly string[]>({
      keys: [keys.card(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
      patch: (client, ids) => {
        patchCardDetail(client, orgId, cardId, (card) => ({ ...card, assigneeIds: [...ids] }));
        patchBoardCards(client, orgId, boardId, (cards) =>
          cards.map((card) => (card.cardId === cardId ? { ...card, assigneeIds: [...ids] } : card)),
        );
      },
      failureTitle: 'Assignees were not saved',
    }),
  });

  const selected = new Set(assigneeIds);

  const toggle = (userId: string) => {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    assign.mutate([...next]);
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Assignees</h3>

      {members.data === undefined ? null : members.data.length === 0 ? (
        <p className="text-xs text-ink-faint">No members to assign.</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {members.data.map((member) => {
            const on = selected.has(member.userId);
            return (
              <li key={member.userId}>
                <button
                  type="button"
                  aria-pressed={on}
                  /* No `disabled` while pending. The write is optimistic, so the
                     button already shows its new state — disabling it would make
                     assigning three people a queue of round trips instead of
                     three clicks. A failure rolls all of it back with a toast. */
                  onClick={() => {
                    toggle(member.userId);
                  }}
                  className={cn(
                    'flex max-w-48 items-center gap-1.5 rounded py-0.5 pr-2 pl-0.5 text-[11px]',
                    on
                      ? 'bg-accent text-accent-ink'
                      : 'bg-surface-hover text-ink-muted hover:text-ink',
                  )}
                  title={member.email}
                >
                  <Avatar userId={member.userId} label={member.email} size="xs" />
                  <span className="truncate">{member.email}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
