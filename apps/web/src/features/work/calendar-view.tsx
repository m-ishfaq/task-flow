import { useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { parseNullableInstant } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import { PRIORITY_SWATCH } from './priority-colors.js';
import type { CardSummary } from './api.js';

/**
 * The calendar view (§10.4's own Calendar/Timeline surface — a real gap this
 * closes, not a follow-up to anything already shipped).
 *
 * Month grid over the SAME `cardsQuery` result board/list/table already
 * read — `board-page.tsx` fetches it once and hands it to whichever view is
 * showing, so switching views stays instant and the views can never disagree
 * about which cards match the current filter. Bucketed by `dueDate` alone:
 * this is "what's due when", not a Gantt-style span view over
 * `startDate`/`dueDate` ranges — `cardsQuery`'s summary shape doesn't even
 * carry `startDate` (see `card-tile.tsx`'s own note on that), and a true
 * timeline is a materially bigger surface than a due-date calendar.
 *
 * The month being VIEWED is local component state, not the URL — unlike
 * `view`/`filter`/`groupBy`/`sortBy` (§10.5), which board-page.tsx owns.
 * Which month someone happens to be looking at is not part of "what this
 * board shows", the same way `table-view.tsx`'s own scroll position isn't;
 * a link to this board should open on the current month, not wherever the
 * last viewer scrolled to.
 */

export interface CalendarViewProps {
  readonly cards: readonly CardSummary[];
  readonly onOpenCard: (cardId: string) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** How many cards a day cell shows before collapsing the rest into a count. */
const MAX_VISIBLE_PER_DAY = 3;

export function CalendarView({ cards, onOpenCard }: CalendarViewProps) {
  // A lazy initializer, not a bare `new Date()` in the render body — the
  // React Compiler purity rule flags reading the clock during render;
  // `formatDueDate`/`hasPassed` in lib/format.ts exist for the identical
  // reason. This runs once, to seed which month opens first.
  const [month, setMonth] = useState(() => new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, CardSummary[]>();
    for (const card of cards) {
      const due = parseNullableInstant(card.dueDate);
      if (due === null) continue;
      const key = format(due, 'yyyy-MM-dd');
      const bucket = map.get(key);
      if (bucket) bucket.push(card);
      else map.set(key, [card]);
    }
    return map;
  }, [cards]);

  const unscheduledCount = cards.filter((card) => card.dueDate === null).length;

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  }, [month]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line/40 px-6 py-2.5">
        <h2 className="text-sm font-semibold text-ink">{format(month, 'MMMM yyyy')}</h2>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => {
              setMonth((current) => subMonths(current, 1));
            }}
            className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => {
              setMonth(new Date());
            }}
            className="rounded px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => {
              setMonth((current) => addMonths(current, 1));
            }}
            className="rounded p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <ChevronRight aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
        </div>

        {unscheduledCount > 0 && (
          <span className="ml-auto text-xs text-ink-faint">
            {unscheduledCount} {unscheduledCount === 1 ? 'card has' : 'cards have'} no due date
          </span>
        )}
      </div>

      <div className="grid grid-cols-7 text-[11px] font-medium text-ink-faint">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="border-b border-line/30 px-2 py-1.5 text-center">
            {label}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 overflow-y-auto border-l border-t border-line/30">
        {days.map((day) => {
          const key = format(day, 'yyyy-MM-dd');
          const dayCards = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, month);
          const overflow = dayCards.length - MAX_VISIBLE_PER_DAY;

          return (
            <div
              key={key}
              className={cn(
                'min-h-24 border-b border-r border-line/30 p-1',
                !inMonth && 'bg-surface-sunken/40',
              )}
            >
              <div
                className={cn(
                  'mb-1 px-1 text-[11px]',
                  isToday(day)
                    ? 'font-semibold text-accent'
                    : inMonth
                      ? 'text-ink-muted'
                      : 'text-ink-faint',
                )}
              >
                {format(day, 'd')}
              </div>

              <div className="space-y-0.5">
                {dayCards.slice(0, MAX_VISIBLE_PER_DAY).map((card) => (
                  <button
                    key={card.cardId}
                    type="button"
                    onClick={() => {
                      onOpenCard(card.cardId);
                    }}
                    title={card.title}
                    className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-ink hover:bg-surface-hover"
                  >
                    {card.priority !== null && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          PRIORITY_SWATCH[card.priority],
                        )}
                      />
                    )}
                    <span className="truncate">{card.title}</span>
                  </button>
                ))}
                {overflow > 0 && (
                  <div className="px-1 text-[10px] text-ink-faint">+{overflow} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
