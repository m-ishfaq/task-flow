import { useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isPast,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarX2, ChevronLeft, ChevronRight } from 'lucide-react';
import { PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import { parseNullableInstant } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import { Empty } from '../../components/primitives.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { PRIORITY_SWATCH } from './priority-colors.js';
import type { CardSummary } from './api.js';

/**
 * The calendar view (§10.4's own Calendar/Timeline surface).
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
 *
 * ## Two renderers, one data model
 *
 * The 7-column grid reads fine at desktop width — a cramped `min-h-24`
 * cell with 3 rows of truncated titles does not survive a phone's width,
 * found from a real report rather than a design review. Below `md:`
 * (`useIsDesktop`, the same 768px breakpoint the rest of the app already
 * coordinates its own responsive layouts against) this renders an AGENDA
 * instead: one row per day that actually has a card, chronological, full
 * titles, no truncation, no cramped 7-across math to fit into a phone's
 * width. Both read the identical `byDay` map built once above them —
 * there is no second query, no second bucketing pass, just two ways of
 * laying the same buckets out.
 */

export interface CalendarViewProps {
  readonly cards: readonly CardSummary[];
  readonly onOpenCard: (cardId: string) => void;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** How many cards a day cell shows before collapsing the rest into a count. */
const MAX_VISIBLE_PER_DAY = 3;

function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** A day strictly before today with at least one card — the calendar's one
    color cue for "this was due and the day has already passed," the same
    date-only definition `lib/format.ts`'s `formatDueDate` uses for a card
    tile's own overdue badge (never accounting for the card's own status —
    see that helper's own precedent, matched here rather than invented). */
function isOverdueDay(day: Date, dayCards: readonly CardSummary[]): boolean {
  return dayCards.length > 0 && isPast(day) && !isToday(day);
}

export function CalendarView({ cards, onOpenCard }: CalendarViewProps) {
  // A lazy initializer, not a bare `new Date()` in the render body — the
  // React Compiler purity rule flags reading the clock during render;
  // `formatDueDate`/`hasPassed` in lib/format.ts exist for the identical
  // reason. This runs once, to seed which month opens first.
  const [month, setMonth] = useState(() => new Date());
  const isDesktop = useIsDesktop();

  const byDay = useMemo(() => {
    const map = new Map<string, CardSummary[]>();
    for (const card of cards) {
      const due = parseNullableInstant(card.dueDate);
      if (due === null) continue;
      const key = dayKey(due);
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
      <div className="flex flex-wrap items-center gap-2 border-b border-line/40 px-4 py-2.5 sm:px-6">
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
          <span className="text-xs text-ink-faint sm:ml-auto">
            {unscheduledCount} {unscheduledCount === 1 ? 'card has' : 'cards have'} no due date
          </span>
        )}
      </div>

      {isDesktop ? (
        <MonthGrid days={days} month={month} byDay={byDay} onOpenCard={onOpenCard} />
      ) : (
        <AgendaList days={days} byDay={byDay} onOpenCard={onOpenCard} />
      )}
    </div>
  );
}

function MonthGrid({
  days,
  month,
  byDay,
  onOpenCard,
}: {
  readonly days: readonly Date[];
  readonly month: Date;
  readonly byDay: ReadonlyMap<string, CardSummary[]>;
  readonly onOpenCard: (cardId: string) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-7 text-xs font-medium text-ink-faint">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="border-b border-line/30 px-2 py-1.5 text-center">
            {label}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 overflow-y-auto border-l border-t border-line/30">
        {days.map((day) => {
          const key = dayKey(day);
          const dayCards = byDay.get(key) ?? [];
          const inMonth = isSameMonth(day, month);
          const overflow = dayCards.length - MAX_VISIBLE_PER_DAY;
          const overdueDay = isOverdueDay(day, dayCards);

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
                  'mb-1 px-1 text-xs',
                  isToday(day)
                    ? 'font-semibold text-accent'
                    : overdueDay
                      ? 'font-medium text-danger'
                      : inMonth
                        ? 'text-ink-muted'
                        : 'text-ink-faint',
                )}
              >
                {format(day, 'd')}
              </div>

              <div className="space-y-0.5">
                {dayCards.slice(0, MAX_VISIBLE_PER_DAY).map((card) => (
                  <CardRow key={card.cardId} card={card} onOpenCard={onOpenCard} />
                ))}
                {overflow > 0 && (
                  <PopoverRoot>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="w-full rounded px-1 text-left text-[10px] text-ink-faint hover:bg-surface-hover hover:text-ink hover:underline"
                      >
                        +{overflow} more
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 p-2">
                      <p className="mb-1 px-1 text-xs font-medium text-ink-muted">
                        {format(day, 'EEEE, d MMMM')}
                      </p>
                      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                        {dayCards.map((card) => (
                          <li key={card.cardId}>
                            <CardRow card={card} onOpenCard={onOpenCard} />
                          </li>
                        ))}
                      </ul>
                    </PopoverContent>
                  </PopoverRoot>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AgendaList({
  days,
  byDay,
  onOpenCard,
}: {
  readonly days: readonly Date[];
  readonly byDay: ReadonlyMap<string, CardSummary[]>;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const rows = days
    .map((day) => ({ day, dayCards: byDay.get(dayKey(day)) ?? [] }))
    .filter((row) => row.dayCards.length > 0);

  if (rows.length === 0) {
    return (
      <div className="flex-1 p-6">
        <Empty
          icon={<CalendarX2 aria-hidden="true" className="size-5" strokeWidth={1.75} />}
          title="Nothing due this month"
          description="No card in this board's filter has a due date in this window."
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 divide-y divide-line/30 overflow-y-auto">
      {rows.map(({ day, dayCards }) => {
        const overdueDay = isOverdueDay(day, dayCards);
        return (
          <div key={dayKey(day)} className="px-4 py-2.5 sm:px-6">
            <p
              className={cn(
                'mb-1.5 text-xs font-semibold',
                isToday(day) ? 'text-accent' : overdueDay ? 'text-danger' : 'text-ink-muted',
              )}
            >
              {format(day, 'EEEE, d MMMM')}
            </p>
            <ul className="space-y-1">
              {dayCards.map((card) => (
                <li key={card.cardId}>
                  <CardRow card={card} onOpenCard={onOpenCard} agenda />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function CardRow({
  card,
  onOpenCard,
  agenda = false,
}: {
  readonly card: CardSummary;
  readonly onOpenCard: (cardId: string) => void;
  readonly agenda?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpenCard(card.cardId);
      }}
      title={card.title}
      className={cn(
        'flex w-full items-center gap-1.5 truncate rounded px-1 text-left text-ink hover:bg-surface-hover',
        agenda ? 'py-1 text-[13px]' : 'py-0.5 text-xs',
      )}
    >
      {card.priority !== null && (
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', PRIORITY_SWATCH[card.priority])}
        />
      )}
      {agenda && (
        <span className="shrink-0 font-mono text-xs text-ink-faint">{card.reference}</span>
      )}
      <span className="truncate">{card.title}</span>
    </button>
  );
}
