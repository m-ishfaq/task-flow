import { useMemo, useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BoardIdSchema, type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { CardRow } from '../../../src/lib/card-row.js';
import {
  MY_TASKS_QUERY_KEY,
  boardCardsQueryKey,
  cardQueryKey,
  listsQueryKey,
  type CardSummary,
} from '../../../src/lib/work.js';

/**
 * One board — Wave 2's remaining roadmap item, following My Tasks and card
 * detail. A fixed, always-visible tab strip (one chip per list, name +
 * card count) over a single virtualized `FlatList` of the SELECTED list's
 * cards — not `apps/web`'s horizontal kanban columns (a phone's width
 * cannot fit two side by side at a readable card size, and a horizontally
 * scrolling board on top of a vertically scrolling screen is the "two
 * scroll directions fighting each other" pattern mobile UI guidance warns
 * against), and not this screen's OWN original layout either: every list's
 * cards stacked in one vertical `ScrollView`, found broken by a real device
 * run against a board with 90+ cards in its first list. That layout forced
 * scrolling through all 90 before a second list's name was even visible —
 * "where a list is, what's next, what's finished" was answered only by a
 * long scroll, not a glance. The tab strip answers it directly: every
 * list's name and count is on screen at once, and switching to see that
 * list's actual cards is one tap, not a scroll. `FlatList` also
 * virtualizes — nothing this screen's old `ScrollView.map()` did — so a
 * 90-card list no longer means 90 mounted rows at once.
 *
 * `work.lists.list` (names, `cardCount`, no cards) and `work.cards.list`
 * (every live card on the board, with `listId`) are two separate reads
 * grouped client-side — the server has no single "board render" route; this
 * is the same shape `apps/web/src/features/work/board-page.tsx` builds its
 * columns from, just grouped in this file instead of a shared query helper,
 * since mobile has no board-specific API layer yet.
 *
 * **No drag-and-drop.** `card-row.tsx`'s own header already makes this call:
 * a full drag implementation is real, separate work (rebalancing, WIP-limit
 * feedback mid-drag). Moving a card here is a discrete "Move" button on each
 * row opening a plain list of the board's OTHER lists — append-to-end only
 * (`beforeCardId`/`afterCardId` both null), no reordering WITHIN a list.
 */
export default function BoardScreen() {
  const params = useLocalSearchParams<{ boardId: string }>();
  const parsedBoardId = BoardIdSchema.safeParse(params.boardId);

  if (!parsedBoardId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This board link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <BoardContent boardId={parsedBoardId.data} />;
}

function BoardContent({ boardId }: { boardId: ReturnType<typeof BoardIdSchema.parse> }) {
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<CardSummary | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);

  const lists = useQuery({
    queryKey: listsQueryKey(boardId),
    queryFn: async () => wire(await apiClient.work.lists.list.query({ boardId })),
  });
  const cards = useQuery({
    queryKey: boardCardsQueryKey(boardId),
    queryFn: async () => wire(await apiClient.work.cards.list.query({ boardId })),
  });

  const cardsByList = useMemo(() => {
    const grouped = new Map<string, CardSummary[]>();
    for (const card of cards.data ?? []) {
      const bucket = grouped.get(card.listId);
      if (bucket) {
        bucket.push(card);
      } else {
        grouped.set(card.listId, [card]);
      }
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    }
    return grouped;
  }, [cards.data]);

  // Falls back to the first list whenever nothing is selected yet, or the
  // selection no longer names a real list (the board's lists reloaded and
  // that one was archived/removed mid-session) — never a blank tab strip
  // with no list's cards showing.
  const activeListId =
    selectedListId !== null && lists.data?.some((list) => list.listId === selectedListId)
      ? selectedListId
      : (lists.data?.[0]?.listId ?? null);
  const activeCards = activeListId === null ? [] : (cardsByList.get(activeListId) ?? []);

  const move = useMutation({
    mutationFn: (input: { cardId: CardId; targetListId: string }) =>
      apiClient.work.cards.move.mutate({
        cardId: input.cardId,
        targetListId: input.targetListId,
        beforeCardId: null,
        afterCardId: null,
      }),
    onSuccess: async () => {
      setMoving(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
        queryClient.invalidateQueries({ queryKey: listsQueryKey(boardId) }),
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: cardQueryKey(moving?.cardId ?? '') }),
      ]);
    },
    onError: (error) => {
      setMoveError(error);
    },
  });
  const paddingTop = useTopInset();

  if (lists.isError || cards.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(lists.error ?? cards.error)?.error.message ?? "Couldn't load this board."}
        </Text>
        <BackButton />
      </View>
    );
  }

  if (lists.isPending || cards.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.header}>
        <BackButton />
      </View>

      {lists.data.length === 0 ? (
        <Text style={styles.label}>This board has no lists yet.</Text>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabStripFrame}
            contentContainerStyle={styles.tabStrip}
          >
            {lists.data.map((list) => (
              <Pressable
                key={list.listId}
                style={[styles.tab, list.listId === activeListId && styles.tabActive]}
                onPress={() => {
                  setSelectedListId(list.listId);
                }}
              >
                <Text
                  style={[styles.tabText, list.listId === activeListId && styles.tabTextActive]}
                  numberOfLines={1}
                >
                  {list.name}
                </Text>
                <Text
                  style={[styles.tabCount, list.listId === activeListId && styles.tabCountActive]}
                >
                  {list.cardCount}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <FlatList<CardSummary>
            key={activeListId}
            data={activeCards}
            keyExtractor={(card) => card.cardId}
            renderItem={({ item }) => (
              <CardRow
                card={item}
                onMove={() => {
                  setMoveError(null);
                  setMoving(item);
                }}
              />
            )}
            contentContainerStyle={styles.cardList}
            style={styles.cardListContainer}
            ListEmptyComponent={<Text style={styles.emptyList}>No cards in this list.</Text>}
          />
        </>
      )}

      <Modal
        visible={moving !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setMoving(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setMoving(null);
          }}
        >
          {/* Consumes the tap so it never bubbles to the backdrop's own
              onPress above — any Pressable with a handler blocks that,
              regardless of what the handler does. */}
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Move "{moving?.title}" to…</Text>
            {moveError !== null && (
              <Text style={styles.modalError} accessibilityRole="alert">
                {apiErrorOf(moveError)?.error.message ?? 'The card could not be moved.'}
              </Text>
            )}
            {lists.data
              .filter((list) => list.listId !== moving?.listId)
              .map((list) => (
                <Pressable
                  key={list.listId}
                  style={styles.modalRow}
                  disabled={move.isPending}
                  onPress={() => {
                    if (moving)
                      move.mutate({ cardId: moving.cardId as CardId, targetListId: list.listId });
                  }}
                >
                  <Text style={styles.modalRowText}>{list.name}</Text>
                </Pressable>
              ))}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setMoving(null);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  tabStrip: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    // `alignItems: 'flex-start'` on a ROW content container is the actual
    // fix — the default cross-axis alignment is 'stretch', which (combined
    // with `flexGrow: 0` below not being enough on its own on Android) is
    // what stretched every chip to the ScrollView's own frame height,
    // rendering each as a near-fullscreen pill instead of a small chip.
    alignItems: 'flex-start',
    gap: 8,
  },
  tabStripFrame: {
    // A horizontal ScrollView with no explicit style otherwise sizes its
    // FRAME (not just its content) to fill remaining flex space from its
    // column parent — found live, rendering four chips as near-fullscreen
    // vertical pills instead of a compact row. `flexGrow: 0` pins the
    // frame to its content height; the `alignItems: 'flex-start'` above
    // is what actually stops each CHIP inside it from stretching to match.
    flexGrow: 0,
    flexShrink: 0,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surfaceRaised.hex,
    maxWidth: 200,
  },
  tabActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  tabTextActive: {
    color: colors.accentInk.hex,
  },
  tabCount: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  tabCountActive: {
    color: colors.accentInk.hex,
  },
  cardListContainer: {
    flex: 1,
  },
  cardList: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 40,
    gap: 8,
  },
  emptyList: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingHorizontal: 24,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
    gap: 4,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  modalError: {
    fontSize: 13,
    color: colors.danger.hex,
    marginBottom: 8,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 15,
    color: colors.ink.hex,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
