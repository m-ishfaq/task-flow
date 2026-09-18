import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ListId, ProjectId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import {
  boardCardsQueryKey,
  boardsQueryKey,
  cardQueryKey,
  listsQueryKey,
  MY_TASKS_QUERY_KEY,
  type Board,
  type ListSummary,
} from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * Where the card lives — its board and its list — as two modal pickers.
 * Mobile port of `apps/web/src/features/work/detail/location-section.tsx`.
 *
 * ## Both pickers, one mutation
 *
 * `cards.move` takes a target LIST and derives everything else: the service
 * reads the destination list and writes its `board_id` and `project_id` onto
 * the card, and authorizes the destination board SEPARATELY from the card's
 * own board — holding `card:move` where the card is now grants nothing about
 * where it is going.
 *
 * So changing the board picker re-scopes the list picker, and the move
 * happens when a list is chosen. That is deliberate: a board is not a
 * destination, only a list is, and moving on board-change would have to
 * invent which of its lists the user meant.
 *
 * ## Cross-project is not offered
 *
 * Only boards in the card's own project are listed. `work.cards` carries a
 * composite foreign key on `(org_id, project_id, status_id)`, and `card_labels`
 * and `custom_field_values` both reference `cards (org_id, project_id, id)` —
 * so changing a card's project orphans its status, labels and custom fields.
 *
 * ## Appending, not inserting
 *
 * The card lands at the END of the destination list. A select conveys "put
 * it there", not "put it third".
 */
export function LocationSection({
  cardId,
  boardId,
  listId,
  projectId,
  canMove,
  onLeaveBoard,
}: {
  readonly cardId: CardId;
  readonly boardId: BoardId;
  readonly listId: string;
  readonly projectId: ProjectId | null;
  readonly canMove: boolean;
  readonly onLeaveBoard: () => void;
}) {
  const queryClient = useQueryClient();

  const [showingBoardId, setShowingBoardId] = useState<BoardId>(boardId);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const [listPickerOpen, setListPickerOpen] = useState(false);

  const boards = useQuery({
    queryKey: projectId !== null ? boardsQueryKey(projectId) : ['work.boards.list', 'none'] as const,
    queryFn: async () => {
      if (projectId === null) return [] as Board[];
      return wire(await apiClient.work.boards.list.query({ projectId }));
    },
    enabled: canMove && projectId !== null,
  });

  const lists = useQuery({
    queryKey: listsQueryKey(showingBoardId),
    queryFn: async () => wire(await apiClient.work.lists.list.query({ boardId: showingBoardId })),
    enabled: canMove,
  });

  // We need the destination board's cards to find the last card in the target
  // list (to append after it, not insert before null which causes rebalance).
  const destCards = useQuery({
    queryKey: boardCardsQueryKey(showingBoardId),
    queryFn: async () => wire(await apiClient.work.cards.list.query({ boardId: showingBoardId })),
    enabled: canMove && showingBoardId !== boardId,
  });

  const move = useMutation({
    mutationFn: (targetListId: ListId) =>
      apiClient.work.cards.move.mutate({
        cardId,
        targetListId,
        beforeCardId: lastCardOf(destCards.data, targetListId),
        afterCardId: null,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
        queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(showingBoardId) }),
        queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      ]);
      if (showingBoardId !== boardId) onLeaveBoard();
    },
  });

  if (!canMove) return null;

  const currentBoard = (boards.data ?? []).find((b) => b.boardId === boardId);
  const showingBoard = (boards.data ?? []).find((b) => b.boardId === showingBoardId);
  const currentList = (lists.data ?? []).find((l) => l.listId === listId);

  return (
    <Section label="Location">
      <Pressable
        style={[styles.priorityChip, styles.priorityChipActive]}
        disabled={move.isPending}
        onPress={() => {
          setBoardPickerOpen(true);
        }}
      >
        <Text style={styles.priorityChipText} numberOfLines={1}>
          {showingBoard?.name ?? currentBoard?.name ?? 'Unknown board'}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.priorityChip, styles.priorityChipActive]}
        disabled={move.isPending}
        onPress={() => {
          setListPickerOpen(true);
        }}
      >
        <Text style={styles.priorityChipText} numberOfLines={1}>
          {showingBoardId === boardId
            ? (currentList?.name ?? 'Unknown list')
            : 'Choose a list…'}
        </Text>
      </Pressable>

      {move.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(move.error)?.error.message ?? 'The card could not be moved.'}
        </Text>
      )}

      {/* Board picker */}
      <Modal
        visible={boardPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setBoardPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setBoardPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Board</Text>
            <ScrollView style={styles.pickerList}>
              {(boards.data ?? []).map((board) => (
                <Pressable
                  key={board.boardId}
                  style={styles.pickerRow}
                  onPress={() => {
                    setShowingBoardId(board.boardId as BoardId);
                    setBoardPickerOpen(false);
                  }}
                >
                  <Text style={styles.pickerRowText} numberOfLines={1}>
                    {board.name}
                  </Text>
                  {board.boardId === showingBoardId && (
                    <Text style={styles.pickerCheck}>✓</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setBoardPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* List picker */}
      <Modal
        visible={listPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setListPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setListPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Move to list</Text>
            <ScrollView style={styles.pickerList}>
              {(lists.data ?? []).map((list) => (
                <Pressable
                  key={list.listId}
                  style={styles.pickerRow}
                  disabled={move.isPending}
                  onPress={() => {
                    setListPickerOpen(false);
                    if (list.listId !== listId || showingBoardId !== boardId) {
                      move.mutate(list.listId as ListId);
                    }
                  }}
                >
                  <Text style={styles.pickerRowText} numberOfLines={1}>
                    {list.name}
                  </Text>
                  {showingBoardId === boardId && list.listId === listId && (
                    <Text style={styles.pickerCheck}>✓</Text>
                  )}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setListPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Section>
  );
}

/**
 * The last card in `listId`, or null when the list is empty.
 * Null means "no card above it" — the first card of an empty column.
 */
function lastCardOf(
  cards: readonly { readonly cardId: string; readonly listId: string }[] | undefined,
  listId: string,
): CardId | null {
  if (cards === undefined) return null;
  const inList = cards.filter((c) => c.listId === listId);
  return (inList[inList.length - 1]?.cardId ?? null) as CardId | null;
}
