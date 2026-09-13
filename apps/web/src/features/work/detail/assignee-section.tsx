import { useState } from 'react';
import { PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import { useMutation } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import type { BoardId, CardId, UserId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { cn } from '../../../lib/cn.js';
import { Avatar, Input } from '../../../components/primitives.js';
import { useMembers } from '../../org/use-members.js';
import { patchBoardCards, patchCardDetail } from '../api.js';

/**
 * Who a card is assigned to.
 *
 * Sends the WHOLE SET rather than an add/remove delta, matching `assignCard` on
 * the server and for the same reason as labels: two people editing assignees
 * concurrently with deltas converge on a set neither of them chose, whereas the
 * intended set means the last writer wins something a human actually asked for.
 *
 * ## A picker, not a wall of chips
 *
 * This used to render every org member as a toggle chip, unconditionally. That
 * is tolerable for a project's label set — five to eight entries, `label-
 * section.tsx` — and is not for the member list: the demo seed alone puts 24
 * people in Acme, and the `large` profile puts 60 in one org. Scrolling past
 * fifty names to find a checkbox to reach the one someone actually wants is the
 * bug this component now fixes.
 *
 * The picker itself is not new — `QuickAssignee` in `card-tile.tsx` built the
 * same Popover-plus-toggle-list for the hover quick action. This is a second
 * occurrence of that pattern, not a first; a third would be the point to pull
 * it into a shared component (`CLAUDE.md`, §6 — extract at three, not two).
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
  /** `card:update` — a viewer/commenter-relation guest sees who is assigned, never the picker or a way to remove one. */
  readonly canEdit: boolean;
}

export function AssigneeSection({
  orgId,
  boardId,
  cardId,
  assigneeIds,
  canEdit,
}: AssigneeSectionProps) {
  const optimistic = useOptimistic();
  const { people, peopleOf } = useMembers();
  const [query, setQuery] = useState('');

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
  const assigned = peopleOf(assigneeIds);

  const toggle = (userId: string) => {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    assign.mutate([...next]);
  };

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === '' ? people : people.filter((member) => member.email.toLowerCase().includes(needle));

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Users aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Assignees
      </h3>

      <div className="flex flex-wrap items-center gap-1.5">
        {assigned.length === 0 && <span className="text-xs text-ink-faint">Unassigned</span>}

        {assigned.map((person) =>
          canEdit ? (
            <button
              key={person.userId}
              type="button"
              /* Clicking an assigned chip removes it — the same "toggle by
                 clicking the chip" gesture `label-section.tsx` already uses, so
                 this does not need a second, unlearned interaction just for
                 people already on the card. */
              onClick={() => {
                toggle(person.userId);
              }}
              title={`Remove ${person.label}`}
              className="flex items-center gap-1.5 rounded-full bg-surface-hover py-0.5 pr-2 pl-0.5 text-xs text-ink-muted hover:text-danger"
            >
              <Avatar userId={person.userId} label={person.label} size="xs" />
              <span className="max-w-32 truncate">{person.label}</span>
            </button>
          ) : (
            <span
              key={person.userId}
              className="flex items-center gap-1.5 rounded-full bg-surface-hover py-0.5 pr-2 pl-0.5 text-xs text-ink-muted"
            >
              <Avatar userId={person.userId} label={person.label} size="xs" />
              <span className="max-w-32 truncate">{person.label}</span>
            </span>
          ),
        )}

        {canEdit && (
          <PopoverRoot
            onOpenChange={(open) => {
              // Cleared on close, not on each keystroke's own render — reopening
              // the picker should not still be filtered from the last time.
              if (!open) setQuery('');
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Add assignee"
                className="flex size-6 items-center justify-center rounded-full text-ink-faint ring-1 ring-line hover:text-ink hover:ring-line-strong"
              >
                <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 space-y-1.5 p-2">
              {people.length === 0 ? (
                <p className="p-1 text-xs text-ink-faint">No members to assign.</p>
              ) : (
                <>
                  {/* Only worth the row past a handful of members — see the
                    header note on why the picker exists at all. */}
                  {people.length > 8 && (
                    <Input
                      aria-label="Search members"
                      placeholder="Search members…"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                      }}
                      className="h-7 text-xs"
                    />
                  )}

                  {filtered.length === 0 ? (
                    <p className="p-1 text-xs text-ink-faint">No matches.</p>
                  ) : (
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                      {filtered.map((member) => {
                        const on = selected.has(member.userId);
                        return (
                          <li key={member.userId}>
                            <button
                              type="button"
                              aria-pressed={on}
                              onClick={() => {
                                toggle(member.userId);
                              }}
                              className={cn(
                                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs',
                                on
                                  ? 'bg-accent text-accent-ink'
                                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                              )}
                            >
                              <Avatar userId={member.userId} label={member.email} size="xs" />
                              <span className="truncate">{member.email}</span>
                              {on && <span className="ml-auto">✓</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </PopoverContent>
          </PopoverRoot>
        )}
      </div>
    </section>
  );
}
