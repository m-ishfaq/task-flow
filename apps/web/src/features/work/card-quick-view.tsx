import { useQuery } from '@tanstack/react-query';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { Spinner } from '../../components/primitives.js';
import { cardQuery } from './api.js';
import { CardDetailPanel } from './detail/card-detail-panel.js';

/**
 * Opens the real card detail panel from a card id alone — no `boardId` in hand
 * yet, which every other caller of `CardDetailPanel` already has because it is
 * reached FROM that board. Originally built for the standup view (§5, "cards
 * can be moved/reassigned/reprioritized directly from this view") and moved
 * here from `features/standup` once the assistant page (§4) needed the exact
 * same mechanism for a `my_cards` tool result — a card id with no board in
 * hand is that same shape regardless of which feature reached it.
 *
 * Rather than rebuilding assignee, priority and location controls a second
 * time, this fetches the one thing missing — the card's own
 * `boardId`/`projectId` — and then mounts the exact same panel the board
 * renders. Every mutation inside it (`cards.assign`, `cards.update`,
 * `cards.move`) is the one the board's detail panel already makes; nothing
 * here is a new write path.
 *
 * `onClose` receives the loaded card (or `undefined` if it never loaded)
 * rather than this component invalidating a query itself — the standup view
 * needs its own buckets refreshed on close (they're computed from
 * assignee/priority/status, all of which this panel can change) and the
 * assistant page needs nothing extra at all; a shared component has no
 * business knowing which sibling views exist, so each caller decides.
 */
export function CardQuickView({
  orgId,
  cardId,
  onClose,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly onClose: (
    card: { readonly boardId: string; readonly projectId: string | null } | undefined,
  ) => void;
}) {
  const card = useQuery(cardQuery(orgId, cardId));

  if (card.data === undefined) {
    /* No modal shell while loading — the fetch is often a cache hit (a
       standup or my_cards result already touched this card's summary), and
       a modal that pops open empty and then fills in reads worse than a
       beat of nothing. */
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
      onClose={() => {
        onClose(card.data);
      }}
    />
  );
}
