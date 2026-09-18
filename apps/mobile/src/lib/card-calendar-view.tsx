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
import { View, Text, Pressable, FlatList } from 'react-native';
import { colors } from '@taskflow/tokens';
import { parseNullableInstant } from '@taskflow/client';
import { CardRow } from './card-row.js';
import type { CardSummary } from './work.js';

/**
 * Calendar view — the mobile counterpart of `calendar-view.tsx` on web.
 *
 * Mobile always renders the agenda view (the web version switches between
 * MonthGrid on desktop and AgendaList on mobile — a 7-column grid doesn't
 * fit a phone width). Two sections: overdue (if any), then today's cards,
 * then the remaining days of the month. Month navigation at the top.
 */

interface DayInfo {
  readonly date: Date;
  readonly cards: readonly CardSummary[];
  readonly isCurrentMonth: boolean;
  readonly isOverdue: boolean;
}

export function CardCalendarView({
  cards,
  onOpenCard,
}: {
  readonly cards: readonly CardSummary[];
  readonly onOpenCard: (cardId: string) => void;
}) {
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

  const dayInfos: readonly DayInfo[] = useMemo(() => {
    return days.map((day) => {
      const key = format(day, 'yyyy-MM-dd');
      const dayCards = byDay.get(key) ?? [];
      return {
        date: day,
        cards: dayCards,
        isCurrentMonth: isSameMonth(day, month),
        isOverdue: dayCards.length > 0 && isPast(day) && !isToday(day),
      };
    });
  }, [days, byDay, month]);

  // Separate overdue from the rest
  const overdueDays = dayInfos.filter((d) => d.isOverdue);
  const nonOverdueDays = dayInfos.filter((d) => !d.isOverdue && d.cards.length > 0);

  return (
    <View style={{ flex: 1 }}>
      {/* Month header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.line.hex,
        }}
      >
        <Pressable
          onPress={() => {
            setMonth((c) => subMonths(c, 1));
          }}
          hitSlop={8}
        >
          <Text style={{ fontSize: 18, color: colors.inkMuted.hex }}>{'\u276E'}</Text>
        </Pressable>
        <Text style={{ fontWeight: '600', color: colors.ink.hex }}>
          {format(month, 'MMMM yyyy')}
        </Text>
        <Pressable
          onPress={() => {
            setMonth(new Date());
          }}
          hitSlop={8}
        >
          <Text style={{ color: colors.accent.hex, fontSize: 12, fontWeight: '500' }}>Today</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setMonth((c) => addMonths(c, 1));
          }}
          hitSlop={8}
        >
          <Text style={{ fontSize: 18, color: colors.inkMuted.hex }}>{'\u276F'}</Text>
        </Pressable>
      </View>

      {unscheduledCount > 0 && (
        <Text
          style={{
            paddingHorizontal: 16,
            marginBottom: 4,
            color: colors.inkMuted.hex,
            fontSize: 12,
          }}
        >
          {unscheduledCount} card{unscheduledCount !== 1 ? 's have' : ' has'} no due date
        </Text>
      )}

      <FlatList
        data={nonOverdueDays}
        keyExtractor={(d) => format(d.date, 'yyyy-MM-dd')}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          overdueDays.length > 0 ? (
            <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
              <Text
                style={{
                  color: colors.danger.hex,
                  fontWeight: '600',
                  marginBottom: 6,
                  fontSize: 12,
                }}
              >
                Overdue
              </Text>
              {overdueDays.map((d) => (
                <DaySection key={format(d.date, 'yyyy-MM-dd')} day={d} onOpenCard={onOpenCard} />
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => <DaySection day={item} onOpenCard={onOpenCard} />}
        ListEmptyComponent={
          <Text
            style={{ padding: 16, textAlign: 'center', color: colors.inkMuted.hex, fontSize: 12 }}
          >
            No cards with due dates this month.
          </Text>
        }
      />
    </View>
  );
}

function DaySection({
  day,
  onOpenCard,
}: {
  readonly day: DayInfo;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const dayLabel = isToday(day.date)
    ? `Today \u2014 ${format(day.date, 'EEE, MMM d')}`
    : format(day.date, 'EEE, MMM d');

  return (
    <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
      <Text
        style={[
          { color: colors.inkMuted.hex, fontSize: 12 },
          day.isOverdue
            ? { color: colors.danger.hex }
            : isToday(day.date)
              ? { color: colors.accent.hex }
              : {},
        ]}
      >
        {dayLabel}
        {day.cards.length > 1 ? ` (${String(day.cards.length)})` : ''}
      </Text>
      {day.cards.map((card) => (
        <CardRow
          key={card.cardId}
          card={card}
          onPress={() => {
            onOpenCard(card.cardId);
          }}
        />
      ))}
    </View>
  );
}
