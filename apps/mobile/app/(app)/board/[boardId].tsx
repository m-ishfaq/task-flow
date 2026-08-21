import { useMemo, useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
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
  type ListSummary,
} from '../../../src/lib/work.js';

/**
 * One board — Wave 2's remaining roadmap item, following My Tasks and card
 * detail. Vertically stacked sections, one per list, rather than
 * `apps/web`'s horizontal kanban columns: a phone's width cannot fit two
 * columns side by side at a readable card size, and a horizontally
 * scrolling board on top of a vertically scrolling screen is exactly the
 * "two scroll directions fighting each other" pattern mobile UI guidance
 * warns against, so this reflows into one vertical scroll instead.
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
    <View style={styles.container}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop }]}>
        <BackButton />
        {lists.data.map((list) => (
          <ListSection
            key={list.listId}
            list={list}
            cards={cardsByList.get(list.listId) ?? []}
            onMove={(card) => {
              setMoveError(null);
              setMoving(card);
            }}
          />
        ))}
        {lists.data.length === 0 && <Text style={styles.label}>This board has no lists yet.</Text>}
      </ScrollView>

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

function ListSection({
  list,
  cards,
  onMove,
}: {
  readonly list: ListSummary;
  readonly cards: readonly CardSummary[];
  readonly onMove: (card: CardSummary) => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{list.name}</Text>
        <Text style={styles.sectionCount}>{list.cardCount}</Text>
      </View>
      {cards.length === 0 ? (
        <Text style={styles.emptyList}>No cards.</Text>
      ) : (
        <View style={styles.cardStack}>
          {cards.map((card) => (
            <CardRow
              key={card.cardId}
              card={card}
              onMove={() => {
                onMove(card);
              }}
            />
          ))}
        </View>
      )}
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
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 20,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  section: {
    gap: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  sectionCount: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  cardStack: {
    gap: 8,
  },
  emptyList: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
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
