import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { Spinner } from '../../components/primitives.js';
import { cardQuery } from '../work/api.js';
import { CardDetailPanel } from '../work/detail/card-detail-panel.js';

/**
 * Opens the real card detail panel from a card id alone — no `boardId` in hand
 * yet, which every other caller of `CardDetailPanel` already has because it is
 * reached FROM that board.
 *
 * This is the whole mechanism behind §5's "cards can be moved/reassigned/
 * reprioritized directly from this view": rather than rebuilding assignee,
 * priority and location controls a second time, this fetches the one thing
 * missing — the card's own `boardId`/`projectId` — and then mounts the exact
 * same panel the board renders. Every mutation inside it (`cards.assign`,
 * `cards.update`, `cards.move`) is the one the board's detail panel already
 * makes; nothing here is a new write path.
 */
export function CardQuickView({
  orgId,
  cardId,
  onClose,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const card = useQuery(cardQuery(orgId, cardId));

  const close = () => {
    /* The standup buckets are computed from assignee/priority/status, all of
       which this panel can change — so closing it is the point at which the
       standup view needs to be told it may be stale, the same "invalidate a
       sibling feature's cache on close" shape `location-section.tsx` already
       uses for a cross-board move. Scoped to this project's standup entries
       specifically (no `sinceHours` in the key prefix), not the whole
       `projects` branch — a card edit has no bearing on the project list,
       boards, or label vocabulary also living under that prefix. */
    if (card.data !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: ['org', orgId, 'projects', card.data.projectId, 'standup'],
      });
    }
    onClose();
  };

  if (card.data === undefined) {
    /* No modal shell while loading — the fetch is usually a cache hit (the
       standup query already touched these cards' summaries), and a modal that
       pops open empty and then fills in reads worse than a beat of nothing. */
    return card.isPending ? (
      <span className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20">
        <Spinner />
      </span>
    ) : null;
  }

  return (
    <CardDetailPanel
      orgId={orgId}
      boardId={card.data.boardId as BoardId}
      cardId={cardId}
      projectId={card.data.projectId as ProjectId | null}
      onClose={close}
    />
  );
}
