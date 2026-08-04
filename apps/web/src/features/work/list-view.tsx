import { useState } from 'react';
import { AvatarStack, Badge, Empty } from '../../components/primitives.js';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useMembers } from '../org/use-members.js';
import { groupCards, sortCards, type GroupBy, type SortBy } from './grouping.js';
import type { CardSummary, ListSummary, Status } from './api.js';
import type { Person } from '../org/use-members.js';

/**
 * The list view (§10.4, `ai/phase-3.5-work-ux.md` §5.6) — collapsible
 * sections over the SAME grouping `board-view.tsx` uses, one row per card.
 *
 * Deliberately not virtualized, unlike `table-view.tsx`. That view is built
 * for a whole PROJECT's cards and exists specifically to survive ten
 * thousand rows; this one reads the same `cardsQuery` as the board, which is
 * scoped to one board and not virtualized there either. Revisit if a board's
 * card count ever approaches the range that mattered for the table.
 *
 * No drag-and-drop and no inline "+ add card" here — both need a LIST to
 * write into, which only the `list` grouping has one of per row; every other
 * grouping's rows are a reshaping of the same underlying cards, not a place
 * new ones are created. Adding a card happens on the board.
 */

export interface ListViewProps {
  readonly lists: readonly ListSummary[];
  readonly cards: readonly CardSummary[];
  readonly statuses: readonly Status[];
  readonly people: readonly Person[];
  readonly groupBy: GroupBy;
  readonly sortBy: SortBy;
  readonly onOpenCard: (cardId: string) => void;
}

export function ListView({ lists, cards, statuses, people, groupBy, sortBy, onOpenCard }: ListViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { peopleOf } = useMembers();

  const groups = groupCards(cards, groupBy, { lists, statuses, people });

  if (groups.length === 0) {
    return (
      <div className="flex-1 p-6">
        <Empty title="No cards" description="Nothing matches this board's filter yet." />
      </div>
    );
  }

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          /* List keeps rank order regardless of `sortBy` — the same rule
             board-view.tsx follows (§3.2): list is the one grouping with a
             real stored order, and every other grouping has no order of its
             own except the one the view's sort setting supplies. */
          const ordered = groupBy === 'list' ? group.cards : sortCards(group.cards, sortBy);

          return (
            <section key={group.key} className="rounded-card border border-line bg-surface-raised">
              <button
                type="button"
                onClick={() => {
                  toggle(group.key);
                }}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span
                  aria-hidden="true"
                  className={cn('text-ink-faint transition-transform', !isCollapsed && 'rotate-90')}
                >
                  ▸
                </span>
                {group.color !== null && (
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: group.color }}
                    aria-hidden="true"
                  />
                )}
                <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  {group.label}
                </h2>
                <span className="text-[11px] text-ink-faint">{group.cards.length}</span>
              </button>

              {!isCollapsed && (
                <ul className="divide-y divide-line border-t border-line">
                  {ordered.map((card) => {
                    const due = formatDueDate(card.dueDate);
                    const assignees = peopleOf(card.assigneeIds);

                    return (
                      <li key={card.cardId}>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenCard(card.cardId);
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover"
                        >
                          <span className="font-mono text-[11px] text-ink-faint">
                            {card.reference}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-ink">
                            {card.title}
                          </span>

                          {card.priority !== null && (
                            <Badge className="capitalize">{card.priority}</Badge>
                          )}

                          {due !== null && (
                            <Badge className={cn(due.overdue && 'bg-danger/20 text-danger')}>
                              {due.label}
                            </Badge>
                          )}

                          {card.checklistTotal > 0 && (
                            <Badge
                              className={cn(
                                card.checklistDone === card.checklistTotal && 'text-success',
                              )}
                            >
                              ☑ {card.checklistDone}/{card.checklistTotal}
                            </Badge>
                          )}

                          {card.commentCount > 0 && <Badge>💬 {card.commentCount}</Badge>}

                          <AvatarStack people={assignees} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
