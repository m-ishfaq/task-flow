import { AvatarStack, Badge } from '../../components/primitives.js';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useMembers } from '../org/use-members.js';
import type { CardSummary } from './api.js';

/**
 * A card as it appears on the board.
 *
 * The counters here — comments, checklist progress — are read straight from the
 * card row, where the API recomputes them inside the writing transaction rather
 * than incrementing them (`counters.ts`). That is what makes it safe to render
 * them as fact: a badge that has drifted looks exactly like one that has not.
 *
 * ## Assignees are faces, not a count
 *
 * `👤 2` said that two people were on a card and refused to say which, so the
 * only way to find out was to open it — on every card, one at a time. That is
 * the question a board is looked at to answer. `useMembers` resolves the ids
 * against the org's member list, which is cached once and shared by every tile,
 * so this costs one query for the whole board rather than one per card.
 *
 * An id that does not resolve falls back to itself rather than disappearing: a
 * member who has left the org is still assigned, and rendering the card as
 * unassigned would misreport it.
 */

export interface CardTileProps {
  readonly card: CardSummary;
  readonly onOpen?: (cardId: string) => void;
  readonly dragging?: boolean;
}

export function CardTile({ card, onOpen, dragging = false }: CardTileProps) {
  const due = formatDueDate(card.dueDate);
  const { peopleOf } = useMembers();
  const assignees = peopleOf(card.assigneeIds);

  const body = (
    <>
      <span className="block text-sm leading-snug text-ink">{card.title}</span>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-ink-faint">{card.reference}</span>

        {due !== null && (
          <Badge className={cn(due.overdue && 'bg-danger/20 text-danger')}>{due.label}</Badge>
        )}

        {card.checklistTotal > 0 && (
          <Badge
            title="Checklist progress"
            className={cn(card.checklistDone === card.checklistTotal && 'text-success')}
          >
            ☑ {card.checklistDone}/{card.checklistTotal}
          </Badge>
        )}

        {card.commentCount > 0 && <Badge title="Comments">💬 {card.commentCount}</Badge>}

        {/* Pushed right and kept on the metadata row rather than wrapping with
            it. Faces are what the eye scans a column for, so they need a fixed
            position — badges reflowing them to a different x per card is what
            makes a board tiring to read. */}
        <span className="ml-auto">
          <AvatarStack people={assignees} />
        </span>
      </div>
    </>
  );

  const className = cn(
    'w-full rounded-card border border-line bg-surface-raised px-2.5 py-2 text-left transition-colors',
    dragging ? 'shadow-lg ring-1 ring-accent' : 'hover:border-line-strong hover:bg-surface-hover',
  );

  /* The drag overlay is not interactive — it is a picture following the pointer
     — so it renders as a div. A button there would be focusable and announced,
     duplicating the real card for anyone using a screen reader. */
  if (onOpen === undefined) {
    return <div className={className}>{body}</div>;
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onOpen(card.cardId);
      }}
    >
      {body}
    </button>
  );
}
