import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleDot, Flag } from 'lucide-react';
import type { BoardId, CardId, ProjectId, StatusCategory, StatusId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { patchBoardCards, patchCardDetail, statusesQuery, type Priority } from '../api.js';
import { PRIORITIES, PRIORITY_LABEL, PRIORITY_SWATCH, PRIORITY_TINT } from '../priority-colors.js';
import { cn } from '../../../lib/cn.js';
import { useUpdateCard } from '../use-update-card.js';

/**
 * A light tint per status CATEGORY, not per individual status — the schema
 * has no per-status color of its own (`work.statuses.category` is the only
 * classification a status carries, `not_started`/`active`/`done`), so this
 * is the coarsest grouping that's actually true of the data, the same
 * "classification stays deterministic, never invented" instinct
 * `standup.service.ts`'s own bucketing already applies elsewhere in this
 * codebase. Kept local rather than in `priority-colors.ts` — nothing else
 * in this app colors a status yet, and extracting a shared module for one
 * caller would be the premature abstraction §6 already warns against.
 */
const STATUS_CATEGORY_TINT: Readonly<Record<StatusCategory, string>> = {
  not_started: 'bg-surface-hover',
  active: 'bg-accent/15',
  done: 'bg-success/15',
};

/**
 * Status and priority — the two card-level fields Wave 2 adds
 * (`ai/phase-3.5-work-ux.md` §5).
 *
 * Two different mutations on purpose, matching the split in `card.service.ts`:
 * status goes through `cards.setStatus`, a dedicated route that emits
 * `card.status_changed`; priority rides `cards.update` alongside title and
 * dates. This component is scoped to ONE card, unlike `useUpdateCard` — so,
 * unlike its board-tile-only optimism, `StatusSection` can patch
 * `keys.card(orgId, cardId)` directly and have the select itself update
 * before the round trip completes.
 */

export interface StatusSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
  readonly statusId: string | null;
  /** `card:update` — disabled, not hidden: the select is also the read display of the current status. */
  readonly canEdit: boolean;
}

export function StatusSection({
  orgId,
  boardId,
  cardId,
  projectId,
  statusId,
  canEdit,
}: StatusSectionProps) {
  const optimistic = useOptimistic();
  const list = useQuery(statusesQuery(orgId, projectId));

  const setStatus = useMutation({
    mutationFn: (next: StatusId | null) =>
      api.work.cards.setStatus.mutate({ cardId, statusId: next }),

    ...optimistic<StatusId | null>({
      keys: [keys.card(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
      patch: (client, next) => {
        patchCardDetail(client, orgId, cardId, (card) => ({ ...card, statusId: next }));
        patchBoardCards(client, orgId, boardId, (cards) =>
          cards.map((card) => (card.cardId === cardId ? { ...card, statusId: next } : card)),
        );
      },
      failureTitle: 'Status was not saved',
    }),
  });

  const category = list.data?.find((status) => status.statusId === statusId)?.category ?? null;

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <CircleDot aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Status
      </h3>
      {/* A colored pill, not a plain white form field — the select is still
          the real control (and the read display, per this prop's own doc
          comment), just tinted by the current status's own CATEGORY so it
          reads at a glance the way every other status/priority surface in
          this app already does, rather than looking like an unstyled
          `<select>` waiting to be filled in. */}
      <select
        aria-label="Status"
        value={statusId ?? ''}
        disabled={!canEdit}
        onChange={(event) => {
          const value = event.target.value;
          setStatus.mutate(value === '' ? null : (value as StatusId));
        }}
        className={cn(
          'h-8 w-full rounded-full border-0 px-3 text-xs font-medium text-ink outline-none disabled:opacity-50',
          category === null ? STATUS_CATEGORY_TINT.not_started : STATUS_CATEGORY_TINT[category],
        )}
      >
        <option value="">No status</option>
        {(list.data ?? []).map((status) => (
          <option key={status.statusId} value={status.statusId}>
            {status.name}
          </option>
        ))}
      </select>
    </section>
  );
}

export interface PrioritySectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly priority: Priority | null;
  /** `card:update` — disabled, not hidden: the select is also the read display of the current priority. */
  readonly canEdit: boolean;
}

/**
 * Goes through `useUpdateCard`, not a bespoke mutation — priority rides
 * `cards.update` on the server, and a caller holding only what this section
 * needs cannot safely call that full-replace route directly (see the comment
 * on `useUpdateCard`). This select therefore waits for the round trip the
 * same way `DatesSection` does; the board tile updates sooner because
 * `useUpdateCard` patches `cardsOfBoard` optimistically.
 */
export function PrioritySection({
  orgId,
  boardId,
  cardId,
  priority,
  canEdit,
}: PrioritySectionProps) {
  const update = useUpdateCard(orgId, boardId);

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Flag aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Priority
      </h3>
      {/* The swatch previews the SELECTED value at the pill's leading edge —
          a native `<option>` cannot carry its own background color, so this
          is the one place the priority-colors.ts palette becomes visible
          INSIDE the control (`PRIORITY_TINT` colors the pill itself now, a
          step further than the old plain-white select this used to be).
          Absent for "No priority": there is no color for "none" to show. */}
      <div className="relative">
        {priority !== null && (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute top-1/2 left-3 size-2 -translate-y-1/2 rounded-full',
              PRIORITY_SWATCH[priority],
            )}
          />
        )}
        <select
          aria-label="Priority"
          value={priority ?? ''}
          disabled={!canEdit}
          onChange={(event) => {
            const value = event.target.value;
            update.mutate({
              cardId,
              patch: { priority: value === '' ? null : (value as Priority) },
            });
          }}
          className={cn(
            'h-8 w-full rounded-full border-0 pr-3 text-xs font-medium text-ink outline-none disabled:opacity-50',
            priority !== null ? cn(PRIORITY_TINT[priority], 'pl-7') : 'bg-surface-hover pl-3',
          )}
        >
          <option value="">No priority</option>
          {PRIORITIES.map((entry) => (
            <option key={entry} value={entry}>
              {PRIORITY_LABEL[entry]}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
