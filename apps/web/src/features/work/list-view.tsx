import { useState } from 'react';
import { Calendar, ChevronRight, MessageSquare, SquareCheck } from 'lucide-react';
import { AvatarStack, Empty } from '../../components/primitives.js';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useMembers } from '../org/use-members.js';
import { groupCards, sortCards, type GroupBy, type SortBy } from './grouping.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from './priority-colors.js';
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
  /** Overridden by `home-page.tsx`, which is not showing a board's filter. */
  readonly emptyDescription?: string;
}

export function ListView({
  lists,
  cards,
  statuses,
  people,
  groupBy,
  sortBy,
  onOpenCard,
  emptyDescription = "Nothing matches this board's filter yet.",
}: ListViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { peopleOf } = useMembers();

  const groups = groupCards(cards, groupBy, { lists, statuses, people });

  if (groups.length === 0) {
    return (
      <div className="flex-1 p-6">
        <Empty title="No cards" description={emptyDescription} />
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* `pb-10` so the last group has room below it before the window edge — a
          list that ends flush with the bottom border reads as truncated. */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 pb-10">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          /* List keeps rank order regardless of `sortBy` — the same rule
             board-view.tsx follows (§3.2): list is the one grouping with a
             real stored order, and every other grouping has no order of its
             own except the one the view's sort setting supplies. */
          const ordered = groupBy === 'list' ? group.cards : sortCards(group.cards, sortBy);

          return (
            <section
              key={group.key}
              className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-sm"
            >
              <button
                type="button"
                onClick={() => {
                  toggle(group.key);
                }}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-hover/60"
              >
                <ChevronRight
                  aria-hidden="true"
                  strokeWidth={2.25}
                  className={cn(
                    'size-4 shrink-0 text-ink-faint transition-transform',
                    !isCollapsed && 'rotate-90',
                  )}
                />
                {group.color !== null && (
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: group.color }}
                    aria-hidden="true"
                  />
                )}
                {/* Sentence-case 13px, matching `Section` — the uppercase
                    micro-label this used to be read as an admin panel's
                    column heading, not as the title of a group of work. */}
                <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                  {group.label}
                </h2>
                <span className="rounded-full bg-surface-hover/80 px-2 py-0.5 text-[11px] font-medium text-ink-faint">
                  {group.cards.length}
                </span>
              </button>

              {!isCollapsed && (
                <ul className="divide-y divide-line/30 border-t border-line/30">
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
                          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover/60"
                        >
                          <span className="shrink-0 rounded-md bg-surface-sunken/80 px-2 py-0.5 font-mono text-[11px] font-medium text-ink-faint">
                            {card.reference}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                            {card.title}
                          </span>

                          {card.priority !== null && (
                            <>
                              {/* Mobile: coloured dot only — saves ~40px per row. */}
                              <span
                                aria-label={PRIORITY_LABEL[card.priority]}
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full md:hidden',
                                  PRIORITY_SWATCH[card.priority],
                                )}
                              />
                              {/* Desktop: full badge with label. */}
                              <span
                                className={cn(
                                  'hidden items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium md:inline-flex',
                                  'bg-surface-hover text-ink-muted',
                                )}
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    'size-1.5 rounded-full',
                                    PRIORITY_SWATCH[card.priority],
                                  )}
                                />
                                {PRIORITY_LABEL[card.priority]}
                              </span>
                            </>
                          )}

                          {due !== null && (
                            <span
                              className={cn(
                                'shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
                                due.overdue
                                  ? 'bg-danger/15 text-danger'
                                  : 'bg-surface-hover text-ink-muted',
                              )}
                            >
                              <Calendar aria-hidden="true" className="size-3" strokeWidth={2} />
                              {due.label}
                            </span>
                          )}

                          {card.checklistTotal > 0 && (
                            <span className="hidden items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium sm:inline-flex bg-surface-hover text-ink-muted">
                              <SquareCheck aria-hidden="true" className="size-3" strokeWidth={2} />
                              {card.checklistDone}/{card.checklistTotal}
                            </span>
                          )}

                          {card.commentCount > 0 && (
                            <span className="hidden items-center gap-1 rounded-md bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-ink-muted md:inline-flex">
                              <MessageSquare
                                aria-hidden="true"
                                className="size-3"
                                strokeWidth={2}
                              />
                              {card.commentCount}
                            </span>
                          )}

                          <span className="hidden md:block">
                            <AvatarStack people={assignees} />
                          </span>
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
