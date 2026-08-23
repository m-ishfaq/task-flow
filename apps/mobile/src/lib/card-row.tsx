import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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

  const isOverdue = due?.overdue === true;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
      onPress={() => {
        router.push(`/card/${card.cardId}`);
      }}
    >
      {/* Priority bar — a thin colored strip on the left edge, matching
          the web redesign's card-tile priority indicator. */}
      {card.priority !== null && (
        <View style={[styles.priorityBar, { backgroundColor: PRIORITY_COLOR[card.priority] }]} />
      )}

      <View style={styles.cardContent}>
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
            <View style={[styles.badge, isOverdue && styles.badgeOverdue]}>
              <Text style={[styles.badgeText, isOverdue && styles.badgeOverdueText]}>
                {due.label}
              </Text>
            </View>
          )}
          {card.checklistTotal > 0 && (
            <View style={[styles.badge, checklistDone && styles.badgeChecklistDone]}>
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
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.12,
        shadowRadius: 3,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  cardPressed: {
    opacity: 0.85,
    backgroundColor: colors.surfaceHover.hex,
  },
  priorityBar: {
    width: 3,
  },
  cardContent: {
    flex: 1,
    padding: 14,
    gap: 10,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  titleColumn: {
    flex: 1,
    gap: 4,
  },
  reference: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
    backgroundColor: colors.surfaceSunken.hex + '80',
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink.hex,
    lineHeight: 20,
  },
  moveButton: {
    borderWidth: 1,
    borderColor: colors.accent.hex + '40',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.accent.hex + '10',
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
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.surfaceHover.hex + '80',
  },
  badgeOverdue: {
    backgroundColor: colors.danger.hex + '20',
    borderWidth: 1,
    borderColor: colors.danger.hex + '30',
  },
  badgeChecklistDone: {
    backgroundColor: colors.success.hex + '15',
    borderWidth: 1,
    borderColor: colors.success.hex + '25',
  },
  swatch: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.inkMuted.hex,
  },
  badgeOverdueText: {
    color: colors.danger.hex,
  },
  badgeDoneText: {
    color: colors.success.hex,
  },
});
