import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { CardRow } from '../../../src/lib/card-row.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { MY_TASKS_QUERY_KEY, type CardSummary } from '../../../src/lib/work.js';

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
 *
 * `CardRow` — the reference/title/badge rendering — moved to
 * `src/lib/card-row.tsx` once `board/[boardId].tsx` needed the identical
 * rendering for a second screen; see that file's own header.
 */
export default function Home() {
  const cards = useQuery({
    queryKey: MY_TASKS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.cards.mine.query({ includeArchived: false })),
  });
  const paddingTop = useTopInset();

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Text style={styles.title}>My Tasks</Text>

      <FlatList<CardSummary>
        data={cards.data}
        keyExtractor={(card) => card.cardId}
        renderItem={({ item }) => <CardRow card={item} />}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  label: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: 8,
  },
});
