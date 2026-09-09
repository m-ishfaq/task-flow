import { useMutation, useQuery } from '@tanstack/react-query';
import { Timer } from 'lucide-react';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { sprintsQuery } from '../api.js';
import { patchBoardCards, patchCardDetail } from '../api.js';

/**
 * Which sprint a card is in — the Sprint field in the card detail panel
 * (`ai/phase-10.5-sprints.md`).
 *
 * `Backlog` is the empty option: the backlog is NOT a row, it is
 * `sprint_id IS NULL`, so leaving the select unset is a real choice, not an
 * absent one.
 *
 * Closed sprints appear in the list but are disabled — a card in a completed
 * sprint is part of the shipped record and must stay there (the service
 * refuses the write; the disabled option is the model's rule made visible,
 * not an authorization guess). The server still answers for every pick.
 */
export interface SprintSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly sprintId: string | null;
  /** `card:update` — disabled, not hidden: the select is also the read display of the current sprint. */
  readonly canEdit: boolean;
}

export function SprintSection({
  orgId,
  boardId,
  cardId,
  projectId,
  sprintId,
  canEdit,
}: SprintSectionProps) {
  const sprints = useQuery(sprintsQuery(orgId, projectId));
  const optimistic = useOptimistic();

  const setSprint = useMutation({
    mutationFn: (next: string | null) =>
      next === null
        ? api.work.cards.releaseSprint.mutate({ cardId })
        : api.work.cards.assignSprint.mutate({ cardId, sprintId: next }),

    /* The card's sprint renders in three places at once — the detail panel
       (this field), the board tile behind it, and the picker's live card
       counts — so the optimistic patch touches all three caches. Adding the
       sprints key to the optimistic cycle means a failed save rolls its
       count back with the card, and a settled one refetches it. */
    ...optimistic<string | null>({
      keys: [
        keys.card(orgId, cardId),
        keys.cardsOfBoard(orgId, boardId),
        keys.sprints(orgId, projectId),
      ],
      patch: (client, next) => {
        patchCardDetail(client, orgId, cardId, (card) => ({ ...card, sprintId: next }));
        patchBoardCards(client, orgId, boardId, (cards) =>
          cards.map((card) => (card.cardId === cardId ? { ...card, sprintId: next } : card)),
        );
      },
      failureTitle: 'The sprint was not saved',
    }),
  });

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Timer aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Sprint
      </h3>
      <select
        aria-label="Sprint"
        value={sprintId ?? ''}
        disabled={!canEdit}
        onChange={(event) => {
          const next = event.target.value === '' ? null : event.target.value;
          /* Picking the sprint the card is already in is a no-op — keep it
             off the wire and out of the cache cycle, the same no-op
             discipline the services keep for identical saves. */
          if (next === sprintId) return;
          setSprint.mutate(next);
        }}
        className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink disabled:opacity-50"
      >
        <option value="">Backlog</option>
        {(sprints.data ?? []).map((sprint) => {
          const closed = sprint.status === 'completed' || sprint.status === 'cancelled';
          return (
            <option key={sprint.sprintId} value={sprint.sprintId} disabled={closed}>
              {sprint.name} · {sprint.startsOn}–{sprint.endsOn}
              {sprint.status === 'active' ? ' (active)' : ''}
            </option>
          );
        })}
      </select>
    </section>
  );
}
