import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors, radiusCard } from '@taskflow/tokens';
import { PRIORITY_COLOR, PRIORITY_LABEL, formatDueDate, type CardSummary } from './work.js';

/**
 * One card, rendered as a row — extracted from `(tabs)/home.tsx`'s original
 * `renderCard` so `board/[boardId].tsx` (Wave 2's board view) does not carry
 * a second copy of the same badge logic. `CardSummary` is `work.cards.mine`'s
 * inferred type, but `work.cards.list` (the board's own card read) shares
 * the identical `CardSummaryOutput` schema server-side — one type, two
 * callers, same as the type itself already documents.
 *
 * `onMove`, when given, renders a small trailing "Move" button — the board
 * view's one card-level action; "My Tasks" passes nothing and gets none.
 * Not a drag gesture: `home.tsx`'s own header already argues why "no
 * drag-and-drop" is the right call for a reshaping-cards-that-live-elsewhere
 * screen, and a kanban board is the SAME argument at list granularity — a
 * full drag implementation is real, separate work (rebalancing, WIP-limit
 * feedback mid-drag), not something to half-build alongside a read screen.
 */
export function CardRow({
  card,
  onMove,
}: {
  readonly card: CardSummary;
  readonly onMove?: () => void;
}): ReactNode {
  const due = formatDueDate(card.dueDate);
  const checklistDone = card.checklistTotal > 0 && card.checklistDone === card.checklistTotal;

  return (
    <Pressable
      style={styles.card}
      onPress={() => {
        router.push(`/card/${card.cardId}`);
      }}
    >
      <View style={styles.topRow}>
        <View style={styles.titleColumn}>
          <Text style={styles.reference}>{card.reference}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {card.title}
          </Text>
        </View>
        {onMove && (
          <Pressable style={styles.moveButton} onPress={onMove} hitSlop={8}>
            <Text style={styles.moveButtonText}>Move</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.badgeRow}>
        {card.priority !== null && (
          <View style={styles.badge}>
            <View style={[styles.swatch, { backgroundColor: PRIORITY_COLOR[card.priority] }]} />
            <Text style={styles.badgeText}>{PRIORITY_LABEL[card.priority]}</Text>
          </View>
        )}
        {due !== null && (
          <View style={[styles.badge, due.overdue && styles.badgeOverdue]}>
            <Text style={[styles.badgeText, due.overdue && styles.badgeOverdueText]}>
              {due.label}
            </Text>
          </View>
        )}
        {card.checklistTotal > 0 && (
          <View style={styles.badge}>
            <Text style={[styles.badgeText, checklistDone && styles.badgeDoneText]}>
              {card.checklistDone}/{card.checklistTotal}
            </Text>
          </View>
        )}
        {card.commentCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>💬 {card.commentCount}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    gap: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  titleColumn: {
    flex: 1,
    gap: 2,
  },
  reference: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
  },
  title: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  moveButton: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  moveButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.surfaceHover.hex,
  },
  badgeOverdue: {
    backgroundColor: colors.danger.hex + '33',
  },
  swatch: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  badgeOverdueText: {
    color: colors.danger.hex,
  },
  badgeDoneText: {
    color: colors.success.hex,
  },
});
