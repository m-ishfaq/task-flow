import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { CardRow } from '../../../src/lib/card-row.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { MY_TASKS_QUERY_KEY, groupCardsByDue, type CardSummary } from '../../../src/lib/work.js';
import { ACTIVE_SPRINTS_QUERY_KEY } from '../../../src/lib/sprints.js';

type Scope = 'all' | 'sprint' | 'backlog';

/**
 * "My Tasks" (ai/phase-14-mobile.md Wave 2 roadmap row: "Work — boards,
 * lists, cards, My Tasks, card detail...") — Wave 2's first slice and the
 * first real product screen on native, replacing Wave 1's placeholder.
 *
 * Ported from `apps/web/src/features/work/home-page.tsx`, not just the
 * board/kanban view: a flat, read-only list of the caller's own cards
 * across every board they can reach (`work.cards.mine`), no drag-and-drop,
 * no optimistic mutations. Tapping a card opens `(app)/card/[cardId].tsx`.
 *
 * **Grouped by due date and nothing else, and a sprint scope filter —
 * closing the two gaps this screen's ORIGINAL flat-list cut left against
 * web.** `groupCardsByDue` (`work.ts`) is the same bucketing web's
 * `groupCards('due', ...)` does, narrowed to the one grouping this screen
 * ever needs — see that function's own header on why the other four
 * `GroupBy` dimensions have no home here. `SectionList` is React Native's
 * own sectioned-list primitive, the direct analogue of `ListView`'s
 * grouped rendering — no new dependency, and it virtualizes exactly like
 * `FlatList` already did.
 *
 * The sprint scope pills (All / This sprint / Backlog) mirror
 * `home-page.tsx`'s own `scope` state exactly, including "offered only
 * when a sprint is actually running" — a team that does not use sprints
 * would otherwise see two filters that both mean "everything" and one
 * that is always empty. `ACTIVE_SPRINTS_QUERY_KEY` (`sprints.ts`) is
 * `work.sprints.active`, ORG-WIDE (no `projectId`) for the identical
 * reason web's own comment gives: My Tasks spans every board, so "this
 * sprint" has to mean membership in ANY active sprint, not one chosen
 * board's.
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
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('all');
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ACTIVE_SPRINTS_QUERY_KEY }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const cards = useQuery({
    queryKey: MY_TASKS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.cards.mine.query({ includeArchived: false })),
  });
  const activeSprints = useQuery({
    queryKey: ACTIVE_SPRINTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.sprints.active.query({})),
  });
  const paddingTop = useTopInset(4);

  const runningSprintIds = useMemo(
    () => new Set((activeSprints.data ?? []).map((sprint) => sprint.sprintId)),
    [activeSprints.data],
  );

  const visible = useMemo(() => {
    const all = cards.data ?? [];
    if (scope === 'all') return all;
    if (scope === 'backlog') return all.filter((card) => card.sprintId === null);
    return all.filter((card) => card.sprintId !== null && runningSprintIds.has(card.sprintId));
  }, [cards.data, scope, runningSprintIds]);

  const groups = useMemo(() => groupCardsByDue(visible), [visible]);

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>My Tasks</Text>
      </View>
      <Text style={styles.subtitle}>
        {visible.length} {visible.length === 1 ? 'card' : 'cards'}
        {scope === 'all'
          ? ' assigned to you, across every board.'
          : scope === 'sprint'
            ? ' assigned to you in a running sprint.'
            : ' assigned to you and not in any sprint.'}
      </Text>

      {runningSprintIds.size > 0 && (
        <View style={styles.scopeRow} accessibilityRole="tablist">
          {(
            [
              ['all', 'All'],
              ['sprint', 'This sprint'],
              ['backlog', 'Backlog'],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              style={[styles.scopeChip, scope === value && styles.scopeChipActive]}
              onPress={() => {
                setScope(value);
              }}
            >
              <Text style={[styles.scopeChipText, scope === value && styles.scopeChipTextActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      <SectionList
        sections={groups.map((group) => ({ title: group.label, data: group.cards }))}
        keyExtractor={(card: CardSummary) => card.cardId}
        renderItem={({ item }) => <CardRow card={item} />}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void doRefresh();
            }}
            tintColor={colors.accent.hex}
          />
        }
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
    paddingHorizontal: 20,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  titleRow: {
    height: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingRight: 120,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    lineHeight: 18,
  },
  scopeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  scopeChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.surfaceRaised.hex,
  },
  scopeChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  scopeChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  scopeChipTextActive: {
    color: colors.accentInk.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 10,
    paddingBottom: 16,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingTop: 12,
    paddingBottom: 6,
    backgroundColor: colors.surface.hex,
  },
  label: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    marginTop: 12,
    textAlign: 'center',
  },
});
