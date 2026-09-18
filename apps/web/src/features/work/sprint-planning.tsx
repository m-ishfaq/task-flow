import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId, SprintId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { boardsQuery, cardsQuery, sprintsQuery, type CardSummary } from './api.js';

/**
 * Sprint planning — the backlog on one side, a sprint on the other
 * (ai/phase-10.6-sprint-flow.md slice 4).
 *
 * ## Why this is not the board with a filter
 *
 * The board's `sprint=` picker answers "what is IN this sprint". Planning is
 * the other question — "what SHOULD be" — and it needs both sets visible at
 * once, because the decision is a comparison. Phase 10.5 chose the picker
 * deliberately and it remains right for reviewing a sprint; it is simply not a
 * planning surface, which is why every tool this product is measured against
 * ships a second screen rather than a filter.
 *
 * ## One board at a time, and it says so
 *
 * A sprint is PROJECT-scoped (0054) but cards are read per BOARD — `cards.list`
 * takes a boardId, and there is no project-wide card route. So the panels show
 * one board's cards, and when a project has several the board is a visible
 * choice rather than a silent "the first one". A planning screen that quietly
 * showed a third of the work would be worse than one that admits its scope.
 *
 * ## Moving is a click, not a drag
 *
 * Deliberate for now: the move is one call to the same `assignSprint` /
 * `releaseSprint` the card detail panel uses, and a button is reachable by
 * keyboard, announced by a screen reader, and testable without simulating
 * pointer physics. Drag-and-drop is the polish pass on top of a working
 * screen, not the thing that makes it work.
 */

export interface SprintPlanningProps {
  readonly orgId: string;
  readonly projectId: ProjectId;
}

export function SprintPlanning({ orgId, projectId }: SprintPlanningProps) {
  const boards = useQuery(boardsQuery(orgId, projectId));
  const sprints = useQuery(sprintsQuery(orgId, projectId));

  const [boardId, setBoardId] = useState<string>('');
  const [sprintId, setSprintId] = useState<string>('');

  const liveBoards = (boards.data ?? []).filter((board) => board.archivedAt === null);
  /* Default to the first board and the sprint most likely to be planned — the
     active one, else the earliest planned. `sprintsQuery` already sorts active
     first, so this is the head of the open ones. */
  const effectiveBoardId = boardId === '' ? (liveBoards[0]?.boardId ?? '') : boardId;
  const openSprints = (sprints.data ?? []).filter(
    (sprint) => sprint.status === 'planned' || sprint.status === 'active',
  );
  const effectiveSprintId = sprintId === '' ? (openSprints[0]?.sprintId ?? '') : sprintId;

  const cards = useQuery({
    ...cardsQuery(orgId, effectiveBoardId as BoardId, null),
    enabled: effectiveBoardId !== '',
  });

  if (boards.isPending || sprints.isPending) return <SkeletonRows rows={4} />;
  if (sprints.isError) return <ErrorText error={sprints.error} />;

  if (openSprints.length === 0) {
    return (
      <Empty
        title="No sprint to plan into"
        description="Create a planned sprint above, then come back to fill it from the backlog."
      />
    );
  }

  if (liveBoards.length === 0) {
    return (
      <Empty
        title="No board yet"
        description="Cards live on a board, so planning needs one. Create a board first."
      />
    );
  }

  const all = cards.data ?? [];
  const backlog = all.filter((card) => card.sprintId === null);
  const inSprint = all.filter((card) => card.sprintId === effectiveSprintId);
  const chosen = openSprints.find((sprint) => sprint.sprintId === effectiveSprintId);

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Plan a sprint</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            Move work between the backlog and the sprint. Done cards stay with their sprint when it
            closes; the rest go where you choose.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Only offered when there is a decision to make — one board needs no
              picker, and an inert control reads as a broken one. */}
          {liveBoards.length > 1 && (
            <select
              aria-label="Board"
              value={effectiveBoardId}
              onChange={(event) => {
                setBoardId(event.target.value);
              }}
              className="select-premium h-7"
            >
              {liveBoards.map((board) => (
                <option key={board.boardId} value={board.boardId}>
                  {board.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Sprint to plan"
            value={effectiveSprintId}
            onChange={(event) => {
              setSprintId(event.target.value);
            }}
            className="select-premium h-7"
          >
            {openSprints.map((sprint) => (
              <option key={sprint.sprintId} value={sprint.sprintId}>
                {sprint.name}
                {sprint.status === 'active' ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cards.isError ? (
        <ErrorText error={cards.error} />
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Panel
            title="Backlog"
            subtitle={`${String(backlog.length)} not in any sprint`}
            cards={backlog}
            empty="Nothing in the backlog on this board."
            actionLabel="Add to sprint"
            orgId={orgId}
            boardId={effectiveBoardId as BoardId}
            projectId={projectId}
            target={effectiveSprintId as SprintId}
          />
          <Panel
            title={chosen?.name ?? 'Sprint'}
            subtitle={`${String(inSprint.length)} in this sprint`}
            cards={inSprint}
            empty="This sprint is empty. Add work from the backlog."
            actionLabel="Send to backlog"
            orgId={orgId}
            boardId={effectiveBoardId as BoardId}
            projectId={projectId}
            target={null}
          />
        </div>
      )}
    </section>
  );
}

function Panel({
  title,
  subtitle,
  cards,
  empty,
  actionLabel,
  orgId,
  boardId,
  projectId,
  target,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly cards: readonly CardSummary[];
  readonly empty: string;
  readonly actionLabel: string;
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly projectId: ProjectId;
  /** Where this panel's button sends a card — a sprint id, or null for the backlog. */
  readonly target: SprintId | null;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const move = useMutation({
    mutationFn: (cardId: string) =>
      target === null
        ? api.work.cards.releaseSprint.mutate({ cardId })
        : api.work.cards.assignSprint.mutate({ cardId, sprintId: target }),
    onSuccess: async () => {
      /* Both panels read the same card query, and the sprint list shows live
         counts — so one move invalidates both. Not optimistic: a planning
         session is a series of deliberate moves, and a card that appears to
         cross and then springs back is worse than one that takes a moment. */
      await queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
      await queryClient.invalidateQueries({ queryKey: keys.sprints(orgId, projectId) });
      await queryClient.invalidateQueries({ queryKey: keys.activeSprints(orgId) });
    },
    onError: (error: unknown) => {
      toast.failure('The card could not be moved', error);
    },
  });

  return (
    <div className="rounded-lg border border-line/50">
      <div className="border-b border-line px-3 py-2">
        <p className="truncate text-xs font-medium text-ink">{title}</p>
        <p className="text-[11px] text-ink-faint">{subtitle}</p>
      </div>

      {cards.length === 0 ? (
        <p className="px-3 py-4 text-center text-[11px] text-ink-faint">{empty}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-line/40 overflow-y-auto">
          {cards.map((card) => (
            <li key={card.cardId} className="flex items-center gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink">{card.title}</p>
                <p className="truncate text-[11px] text-ink-faint">{card.reference}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 shrink-0 px-2 text-[11px]"
                disabled={move.isPending}
                onClick={() => {
                  move.mutate(card.cardId);
                }}
              >
                {actionLabel}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
