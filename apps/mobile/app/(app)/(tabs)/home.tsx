import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import {
  MY_TASKS_QUERY_KEY,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  formatDueDate,
  type CardSummary,
} from '../../../src/lib/work.js';

/**
 * "My Tasks" (ai/phase-14-mobile.md Wave 2 roadmap row: "Work — boards,
 * lists, cards, My Tasks, card detail...") — Wave 2's first slice and the
 * first real product screen on native, replacing Wave 1's placeholder.
 *
 * Deliberately the SMALLEST useful cut of Work, mirroring
 * `apps/web/src/features/work/home-page.tsx` + `list-view.tsx`, not the
 * board/kanban view: a flat, read-only list of the caller's own cards
 * across every board they can reach (`work.cards.mine`), no drag-and-drop,
 * no optimistic mutations. Tapping a card opens `(app)/card/[cardId].tsx`.
 *
 * Status is deliberately NOT shown, matching `home-page.tsx` exactly — see
 * that investigation's own finding: status definitions are per-PROJECT
 * (Phase 3.5), "My Tasks" spans many projects at once, and nothing in this
 * codebase has ever needed to batch-resolve status names/colors across
 * projects for one screen. Priority has no such problem — it is a fixed
 * four-value enum, not project-scoped data — so it renders here for free.
 *
 * Lives under `(app)/(tabs)/` now, not directly under `(app)/` — the
 * navigation-shell increment that added the tab bar (see `_layout.tsx` in
 * this folder). Passkey enrollment and sign-out, which used to sit in a
 * footer here because this was the whole signed-in app, moved to the
 * Account tab: mirroring apps/web, where neither lives on the "My tasks"
 * page either (`AccountPage`/the sidebar's account menu own them).
 */
export default function Home() {
  const cards = useQuery({
    queryKey: MY_TASKS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.cards.mine.query({ includeArchived: false })),
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Tasks</Text>

      <FlatList<CardSummary>
        data={cards.data}
        keyExtractor={(card) => card.cardId}
        renderItem={renderCard}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          cards.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>Nothing assigned to you right now.</Text>
          )
        }
      />
    </View>
  );
}

function renderCard({ item: card }: ListRenderItemInfo<CardSummary>) {
  const due = formatDueDate(card.dueDate);
  const checklistDone = card.checklistTotal > 0 && card.checklistDone === card.checklistTotal;

  return (
    <Pressable
      style={styles.card}
      onPress={() => {
        router.push(`/card/${card.cardId}`);
      }}
    >
      <View style={styles.cardTopRow}>
        <Text style={styles.reference}>{card.reference}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
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
  container: {
    flex: 1,
    paddingTop: 24,
    paddingHorizontal: 24,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 8,
    paddingBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    gap: 8,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reference: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
  },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    color: colors.ink.hex,
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
  label: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: 8,
  },
});
