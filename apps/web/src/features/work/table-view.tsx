import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BoardId, CardId } from '@taskflow/contracts';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Badge, FocusOnMountInput } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useUpdateCard } from './use-update-card.js';
import type { CardSummary, ListSummary } from './api.js';

/**
 * The table view (§10.4 — TanStack Virtual, inline edit).
 *
 * Virtualized because this view is the one that is asked to show a whole
 * project. A board is naturally chunked into columns of a few dozen; a table has
 * no such limit, and rendering ten thousand rows is a locked tab.
 *
 * ## Inline edit goes through `useUpdateCard`, never `cards.update` directly
 *
 * A row here is a card SUMMARY: `cards.list` returns no description and no start
 * date. `cards.update` is a full replace, so sending a row from this table would
 * write `description: null` for every card renamed in the table view — silently,
 * because the field is not on screen. `useUpdateCard` reads the full card first
 * for exactly that reason; see the comment there.
 */

export interface TableViewProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly lists: readonly ListSummary[];
  readonly cards: readonly CardSummary[];
  readonly onOpenCard: (cardId: string) => void;
}

const ROW_HEIGHT = 36;

export function TableView({ orgId, boardId, lists, cards, onOpenCard }: TableViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const update = useUpdateCard(orgId, boardId);

  const listNames = new Map(lists.map((list) => [list.listId, list.name]));

  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const commit = (cardId: string, title: string) => {
    setEditing(null);
    const trimmed = title.trim();
    const card = cards.find((entry) => entry.cardId === cardId);
    if (trimmed === '' || card === undefined || trimmed === card.title) return;

    update.mutate({ cardId: cardId as CardId, patch: { title: trimmed } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {update.isError && (
        <div className="p-3">
          <ErrorView error={update.error} title="The card could not be saved" />
        </div>
      )}

      <div
        className="grid shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[11px] font-medium tracking-wide text-ink-faint uppercase"
        style={{ gridTemplateColumns: TEMPLATE }}
      >
        <span>Ref</span>
        <span>Title</span>
        <span>List</span>
        <span>Due</span>
        <span>Progress</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const card = cards[virtualRow.index];
            if (card === undefined) return null;

            const due = formatDueDate(card.dueDate);
            const isEditing = editing === card.cardId;

            return (
              <div
                key={card.cardId}
                className="absolute top-0 left-0 grid w-full items-center gap-2 border-b border-line/50 px-4 text-sm hover:bg-surface-raised"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${String(virtualRow.start)}px)`,
                  gridTemplateColumns: TEMPLATE,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onOpenCard(card.cardId);
                  }}
                  className="text-left font-mono text-[11px] text-ink-faint hover:text-accent"
                >
                  {card.reference}
                </button>

                {isEditing ? (
                  <FocusOnMountInput
                    aria-label="Card title"
                    defaultValue={card.title}
                    className="h-7"
                    onBlur={(event) => {
                      commit(card.cardId, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') {
                        /* Reset before blurring, so the blur handler sees the
                           original value and treats the edit as a no-op.
                           Otherwise Escape saves, which is the opposite of what
                           every text field in every application does. */
                        event.currentTarget.value = card.title;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="truncate text-left text-ink hover:text-accent"
                    onDoubleClick={() => {
                      setEditing(card.cardId);
                    }}
                    onClick={() => {
                      onOpenCard(card.cardId);
                    }}
                    title="Click to open, double-click to rename"
                  >
                    {card.title}
                  </button>
                )}

                <span className="truncate text-xs text-ink-muted">
                  {listNames.get(card.listId) ?? '—'}
                </span>

                <span className="text-xs">
                  {due === null ? (
                    <span className="text-ink-faint">—</span>
                  ) : (
                    <span className={cn(due.overdue ? 'text-danger' : 'text-ink-muted')}>
                      {due.label}
                    </span>
                  )}
                </span>

                <span className="flex gap-1">
                  {card.checklistTotal > 0 && (
                    <Badge>
                      {card.checklistDone}/{card.checklistTotal}
                    </Badge>
                  )}
                  {card.commentCount > 0 && <Badge>💬 {card.commentCount}</Badge>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const TEMPLATE = '5rem minmax(0, 1fr) 8rem 6rem 7rem';
