import { useMemo, useState } from 'react';
import { useLocalSearchParams, router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BoardIdSchema, type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useBoardRoom } from '../../../src/lib/use-board-room.js';
import { useMembers } from '../../../src/lib/use-members.js';
import { CardRow } from '../../../src/lib/card-row.js';
import { mergePatch } from '../../../src/lib/card-patch.js';
import { describeOutcome, runBulk } from '../../../src/lib/work-bulk.js';
import { ShareBoardButton } from '../../../src/lib/share-board-modal.js';
import { BoardFilterButton } from '../../../src/lib/board-filter-sheet.js';
import {
  EMPTY_BOARD_FILTER,
  boardFilterKey,
  buildBoardFilter,
  type BoardFilterSelection,
} from '../../../src/lib/board-filter.js';
import {
  MY_TASKS_QUERY_KEY,
  PRIORITY_LABEL,
  archivedCardsQueryKey,
  archivedListsQueryKey,
  boardCardsQueryKey,
  cardQueryKey,
  filteredBoardCardsQueryKey,
  statusesQueryKey,
  listsQueryKey,
  type CardDetail,
  type CardSummary,
  type ListSummary,
  type Priority,
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
 *
 * **Creating cards and lists, WIP limits, and list rename/archive** close
 * the gap a systematic audit against `apps/web/src/features/work/
 * list-column.tsx` and `add-list.tsx` found: this screen could previously
 * only READ a board that already existed, with no way to grow one. Ported
 * with the same non-obvious behavior web's own comments call out:
 *
 *   - **Add Card clears its field on SUBMIT, not on success**, and restores
 *     the title only if the box is still empty on failure — someone who
 *     already started the next card must not have it overwritten by the
 *     previous one's recovery. Deliberately still not OPTIMISTIC: a card's
 *     reference (`WEB-142`) is server-assigned from a per-project counter,
 *     and a number that changes under the reader a moment later is worse
 *     than one that appears a moment late.
 *   - **The WIP limit is displayed, never enforced** — `count`/`count/limit`
 *     in the tab, the limit half in a warning color once over. `cards.move`
 *     reports the breach and completes the move regardless (§10.1: blocking
 *     someone from recording work already in progress stops them using the
 *     board, not stops the work).
 *   - **List options (rename / WIP limit / archive) open on a LONG PRESS of
 *     a tab**, the same gesture `channel/[channelId].tsx` already uses for
 *     a message's action sheet — chosen over a per-tab "⋯" button, which a
 *     narrow chip has no room for without crowding the name and count it
 *     already carries.
 *
 * **Still explicitly out of scope, real and separate work**: list
 * REORDERING (web's own left/right buttons in `ListMenu` have no mobile
 * equivalent yet — the tab strip's order is whatever `lists.list` returns),
 * SAVED views (`BoardFilterButton`'s own selection resets on leaving the
 * screen — no `work.views.*` persistence yet, a real, separate follow-up),
 * and the group-by/sort-by controls `home.tsx`'s own due-date grouping is
 * the one instance of on this app so far. **Filtering itself is no longer
 * on this list** — `board-filter.ts`/`board-filter-sheet.tsx`'s
 * `BoardFilterButton`, ported as a simplified status/priority/assignee/
 * label chip filter rather than web's full AND/OR tree editor, the same
 * "flat, not a reduced port of the tree" call `search-button.tsx`'s own
 * header makes for TQL text. Tab counts stay unfiltered — they answer
 * "how close to this list's WIP limit," a question the true count answers
 * and a filtered one would not — while the card list itself narrows.
 *
 * **`useBoardRoom` joins this board's room** — `gatewaySocket`'s first real
 * caller on this app (see that hook's own header for why `card/[cardId].tsx`
 * deliberately does not also call it). A card someone else moves, edits, or
 * comments on now appears here live, without leaving and reopening the
 * board.
 *
 * **"Add a list" and "List options" are now wrapped in `KeyboardAvoidingView`**
 * — both open a `TextInput` (the first `autoFocus`ed) inside a bottom-anchored
 * sheet with nothing shrinking the screen when the keyboard rose, the same
 * "composer behind the keyboard" shape this app has now hit four times (see
 * `telephony-contact-picker.tsx`'s own header, found from the same live
 * report). Fixed identically: `KeyboardAvoidingView` (`'padding'` on iOS,
 * `'height'` on Android) around each modal's backdrop.
 *
 * **Bulk actions — long-press a card to enter selection mode, ported from
 * `apps/web/src/features/work/bulk-bar.tsx`.** `work-bulk.ts`'s `runBulk` is
 * the identical concurrency-4 loop over the SAME per-card routes the
 * single-card UI calls — there is no bulk endpoint, deliberately
 * (`ai/phase-3.5-work-ux.md` §6: a `cards.bulkUpdate` would authorize once,
 * against something, and the something would not be each card). That makes
 * partial failure the normal case: selecting cards across two lists and
 * archiving them SHOULD archive the ones the caller may edit and refuse the
 * rest, so nothing here reports "done" — it reports what `describeOutcome`
 * says happened, via `Alert.alert` (this app's own established substitute
 * for web's toast, `use-update-card.ts`'s own header). No optimistic patch,
 * for the identical reason web's bar has none: an optimistic patch is a bet
 * the write succeeds, and per-card authorization means that bet is wrong by
 * construction across a selection. `card-row.tsx`'s `selected`/`onPress`/
 * `onLongPress` props are additive — `home.tsx` never passes them, so
 * nothing there changes. Selection is board-wide, not list-scoped: it lives
 * in `selectedIds`, not in anything keyed by `activeListId`, so switching
 * tabs mid-selection keeps what was already picked, matching web's bar
 * being rendered once for the whole board rather than once per column.
 * Status/Priority/Assign each open the same small bottom-sheet picker this
 * file already uses for "Move"; priority alone needs a read-then-patch
 * (`bulkSetPriority`, mirroring `use-update-card.ts`'s `applyPatch`) because
 * `cards.update` is a full replace and `setStatus`/`assign` are not. Archive
 * is immediate, matching web's own ghost button with no confirmation. **This
 * used to say there was no archived-cards RESTORE view on this app — closed
 * in the same pass that added this note's correction, see the "Archived"
 * button below and `ArchivedCardsList`/`ArchivedListsList`.**
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
  const orgId = useSession((state) => state.orgId);
  useBoardRoom(orgId, boardId);
  const [moving, setMoving] = useState<CardSummary | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [addingList, setAddingList] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [listOptionsFor, setListOptionsFor] = useState<ListSummary | null>(null);
  const [optionsName, setOptionsName] = useState('');
  const [optionsWip, setOptionsWip] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkPicker, setBulkPicker] = useState<'status' | 'priority' | 'assignee' | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { people, personOf } = useMembers();
  const [optionsError, setOptionsError] = useState<unknown>(null);

  const lists = useQuery({
    queryKey: listsQueryKey(boardId),
    queryFn: async () => wire(await apiClient.work.lists.list.query({ boardId })),
  });
  const [filterSelection, setFilterSelection] = useState<BoardFilterSelection>(EMPTY_BOARD_FILTER);
  const filterNode = buildBoardFilter(filterSelection);

  const cards = useQuery({
    queryKey: filteredBoardCardsQueryKey(boardId, boardFilterKey(filterNode)),
    queryFn: async () =>
      wire(await apiClient.work.cards.list.query({ boardId, filter: filterNode })),
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

  const refreshBoard = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
      queryClient.invalidateQueries({ queryKey: listsQueryKey(boardId) }),
    ]);

  const toggleSelect = (cardId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  };

  // Selection is board-wide, not list-scoped — switching tabs mid-selection
  // keeps what was already picked, the same as web's bar being rendered once
  // for the whole board rather than once per column.
  const selectionMode = selectedIds.size > 0;

  // Any card on the board answers this the same way (`project_id` is
  // denormalized onto every card — CLAUDE.md's own note on why). Shared by
  // the bulk-action status picker below AND `BoardFilterButton`'s own
  // status/label chip rows, since neither has any other source for it.
  //
  // Captured ONCE from the first response that has one, not re-derived on
  // every render — `cards` is now filter-aware, and a filter that narrows
  // the board to zero rows would otherwise make this go back to null the
  // moment someone actually uses the filter it feeds, breaking the very
  // sheet that set it.
  const [capturedProjectId, setCapturedProjectId] = useState<string | null>(null);
  const firstCardProjectId = cards.data?.[0]?.projectId ?? null;
  if (firstCardProjectId !== null && capturedProjectId === null) {
    setCapturedProjectId(firstCardProjectId);
  }
  const boardProjectId = capturedProjectId;
  const bulkStatuses = useQuery({
    queryKey: statusesQueryKey(boardProjectId ?? ''),
    queryFn: async () =>
      wire(await apiClient.work.statuses.list.query({ projectId: boardProjectId ?? '' })),
    enabled: bulkPicker === 'status' && boardProjectId !== null,
  });

  /**
   * One loop over the same per-card routes the single-card UI calls — see
   * `work-bulk.ts` for why there is no bulk endpoint. No optimistic patch,
   * unlike every single-card mutation in this app: per-card authorization
   * means a partial outcome is the DESIGNED behaviour, and an optimistic
   * patch would show every selected card changing and then roll some back,
   * which reads as the board glitching rather than as a permission
   * boundary. Ported from `apps/web/src/features/work/bulk-bar.tsx`'s `run`.
   */
  const runBulkAction = async (
    verb: string,
    apply: (cardId: string) => Promise<unknown>,
  ): Promise<void> => {
    const ids = [...selectedIds];
    setBulkPicker(null);
    setBulkRunning(true);
    try {
      const outcome = await runBulk(ids, apply);
      await refreshBoard();
      Alert.alert(describeOutcome(outcome, verb));
      // Only clear on a clean run — leaving a partial selection in place is
      // what lets someone see which cards were refused and act on them.
      if (outcome.failed.length === 0) setSelectedIds(new Set());
    } finally {
      setBulkRunning(false);
    }
  };

  const bulkSetPriority = async (cardId: string, priority: Priority | null): Promise<unknown> => {
    // `cards.update` is a full replace — read-then-patch, exactly as
    // `use-update-card.ts`'s `applyPatch` does, since `setStatus`/`assign`
    // have dedicated routes but priority does not.
    const current: CardDetail = wire(await apiClient.work.cards.get.query({ cardId }));
    return apiClient.work.cards.update.mutate({
      cardId,
      version: current.version,
      ...mergePatch(current, { priority }),
    });
  };

  // Field clears on SUBMIT, not on success, and only refills on failure if
  // the box is still empty — see this file's own header on why, and why
  // there is still no optimistic insert (the reference is server-assigned).
  const createCard = useMutation({
    mutationFn: (input: { listId: string; title: string }) =>
      apiClient.work.cards.create.mutate({ listId: input.listId, title: input.title }),
    onError: (_error, input) => {
      setNewCardTitle((current) => (current === '' ? input.title : current));
    },
    onSettled: async () => {
      await refreshBoard();
    },
  });

  const createList = useMutation({
    mutationFn: (name: string) => apiClient.work.lists.create.mutate({ boardId, name }),
    onSuccess: async (result) => {
      setAddingList(false);
      setNewListName('');
      setSelectedListId(result.listId);
      await refreshBoard();
    },
  });

  const updateList = useMutation({
    mutationFn: (input: { listId: string; name: string; wipLimit: number | null }) =>
      apiClient.work.lists.update.mutate(input),
    onSuccess: async () => {
      setListOptionsFor(null);
      await refreshBoard();
    },
    onError: (error) => {
      setOptionsError(error);
    },
  });

  const archiveList = useMutation({
    mutationFn: (listId: string) => apiClient.work.lists.archive.mutate({ listId, archived: true }),
    onSuccess: async () => {
      setListOptionsFor(null);
      if (selectedListId === listOptionsFor?.listId) setSelectedListId(null);
      await refreshBoard();
    },
    onError: (error) => {
      setOptionsError(error);
    },
  });

  const paddingTop = useTopInset(4);

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
      {/* Row 1: back button only — sits in the same 36 px band as TopBar's
          icon cluster (which lives at the same y-coordinate on the right).
          Keeping row 1 left-only prevents the board's own action chips from
          colliding with those absolute-positioned icons. */}
      <View style={styles.backRow}>
        <BackButton />
      </View>
      {/* Row 2: board actions — Filter, Share, Archived — below the TopBar
          zone, so they never overlap with the global icon row. */}
      <View style={styles.actionRow}>
        <BoardFilterButton
          projectId={boardProjectId}
          selection={filterSelection}
          onChange={setFilterSelection}
        />
        <ShareBoardButton boardId={boardId} />
        <Pressable
          style={styles.archivedButton}
          onPress={() => {
            setArchivedOpen(true);
          }}
        >
          <Text style={styles.archivedButtonText}>Archived</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabStripFrame}
        contentContainerStyle={styles.tabStrip}
      >
        {lists.data.map((list) => {
          const overLimit = list.wipLimit !== null && list.cardCount > list.wipLimit;
          return (
            <Pressable
              key={list.listId}
              style={[styles.tab, list.listId === activeListId && styles.tabActive]}
              onPress={() => {
                setSelectedListId(list.listId);
              }}
              onLongPress={() => {
                setListOptionsFor(list);
                setOptionsName(list.name);
                setOptionsWip(list.wipLimit === null ? '' : String(list.wipLimit));
                setOptionsError(null);
              }}
            >
              <Text
                style={[styles.tabText, list.listId === activeListId && styles.tabTextActive]}
                numberOfLines={1}
              >
                {list.name}
              </Text>
              <Text
                style={[
                  styles.tabCount,
                  list.listId === activeListId && styles.tabCountActive,
                  overLimit && styles.tabCountWarning,
                ]}
              >
                {list.cardCount}
                {list.wipLimit !== null && `/${String(list.wipLimit)}`}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          style={styles.addListTab}
          onPress={() => {
            setNewListName('');
            setAddingList(true);
          }}
        >
          <Text style={styles.addListTabText}>+ Add list</Text>
        </Pressable>
      </ScrollView>

      {lists.data.length === 0 ? (
        <Text style={styles.label}>This board has no lists yet — add one to get started.</Text>
      ) : (
        <FlatList<CardSummary>
          key={activeListId}
          data={activeCards}
          keyExtractor={(card) => card.cardId}
          renderItem={({ item }) => (
            <CardRow
              card={item}
              onMove={
                selectionMode
                  ? undefined
                  : () => {
                      setMoveError(null);
                      setMoving(item);
                    }
              }
              selected={selectionMode ? selectedIds.has(item.cardId) : undefined}
              onPress={
                selectionMode
                  ? () => {
                      toggleSelect(item.cardId);
                    }
                  : undefined
              }
              onLongPress={() => {
                toggleSelect(item.cardId);
              }}
            />
          )}
          contentContainerStyle={styles.cardList}
          style={styles.cardListContainer}
          ListEmptyComponent={<Text style={styles.emptyList}>No cards in this list.</Text>}
        />
      )}

      {selectionMode ? (
        <View style={styles.bulkBar} accessibilityRole="menubar" accessibilityLabel="Bulk actions">
          <Text style={styles.bulkBarCount}>{selectedIds.size} selected</Text>
          <View style={styles.bulkBarActions}>
            <Pressable
              style={styles.bulkBarButton}
              disabled={bulkRunning}
              onPress={() => {
                setBulkPicker('status');
              }}
            >
              <Text style={styles.bulkBarButtonText}>Status</Text>
            </Pressable>
            <Pressable
              style={styles.bulkBarButton}
              disabled={bulkRunning}
              onPress={() => {
                setBulkPicker('priority');
              }}
            >
              <Text style={styles.bulkBarButtonText}>Priority</Text>
            </Pressable>
            <Pressable
              style={styles.bulkBarButton}
              disabled={bulkRunning}
              onPress={() => {
                setBulkPicker('assignee');
              }}
            >
              <Text style={styles.bulkBarButtonText}>Assign</Text>
            </Pressable>
            <Pressable
              style={styles.bulkBarButton}
              disabled={bulkRunning}
              onPress={() => {
                void runBulkAction('archived', (cardId) =>
                  apiClient.work.cards.archive.mutate({ cardId, archived: true }),
                );
              }}
            >
              <Text style={styles.bulkBarButtonText}>Archive</Text>
            </Pressable>
            <Pressable
              style={styles.bulkBarButton}
              disabled={bulkRunning}
              onPress={() => {
                setSelectedIds(new Set());
              }}
            >
              <Text style={styles.bulkBarButtonText}>Clear</Text>
            </Pressable>
          </View>
          {bulkRunning && (
            <ActivityIndicator color={colors.accent.hex} style={styles.bulkBarSpinner} />
          )}
        </View>
      ) : (
        <>
          {activeListId !== null && (
            <View style={styles.addCardRow}>
              <TextInput
                style={styles.addCardInput}
                placeholder="Add a card"
                placeholderTextColor={colors.inkFaint.hex}
                value={newCardTitle}
                onChangeText={setNewCardTitle}
                onSubmitEditing={() => {
                  const value = newCardTitle.trim();
                  if (value === '') return;
                  setNewCardTitle('');
                  createCard.mutate({ listId: activeListId, title: value });
                }}
              />
              <Pressable
                style={styles.addCardButton}
                onPress={() => {
                  const value = newCardTitle.trim();
                  if (value === '') return;
                  setNewCardTitle('');
                  createCard.mutate({ listId: activeListId, title: value });
                }}
              >
                <Text style={styles.addCardButtonText}>Add</Text>
              </Pressable>
            </View>
          )}
          {createCard.isError && (
            <Text style={styles.error} accessibilityRole="alert">
              {apiErrorOf(createCard.error)?.error.message ?? 'The card was not created.'}
            </Text>
          )}
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

      <Modal
        visible={bulkPicker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setBulkPicker(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setBulkPicker(null);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>
              {bulkPicker === 'status'
                ? 'Set status'
                : bulkPicker === 'priority'
                  ? 'Set priority'
                  : 'Assign to'}
            </Text>
            <ScrollView style={styles.bulkPickerList}>
              {bulkPicker === 'status' && (
                <>
                  <Pressable
                    style={styles.modalRow}
                    onPress={() => {
                      void runBulkAction('updated', (cardId) =>
                        apiClient.work.cards.setStatus.mutate({
                          cardId,
                          statusId: null,
                        }),
                      );
                    }}
                  >
                    <Text style={styles.modalRowText}>No status</Text>
                  </Pressable>
                  {(bulkStatuses.data ?? []).map((status) => (
                    <Pressable
                      key={status.statusId}
                      style={styles.modalRow}
                      onPress={() => {
                        void runBulkAction('updated', (cardId) =>
                          apiClient.work.cards.setStatus.mutate({
                            cardId,
                            statusId: status.statusId,
                          }),
                        );
                      }}
                    >
                      <Text style={styles.modalRowText}>{status.name}</Text>
                    </Pressable>
                  ))}
                </>
              )}
              {bulkPicker === 'priority' && (
                <>
                  <Pressable
                    style={styles.modalRow}
                    onPress={() => {
                      void runBulkAction('updated', (cardId) => bulkSetPriority(cardId, null));
                    }}
                  >
                    <Text style={styles.modalRowText}>No priority</Text>
                  </Pressable>
                  {(Object.keys(PRIORITY_LABEL) as Priority[]).map((priority) => (
                    <Pressable
                      key={priority}
                      style={styles.modalRow}
                      onPress={() => {
                        void runBulkAction('updated', (cardId) =>
                          bulkSetPriority(cardId, priority),
                        );
                      }}
                    >
                      <Text style={styles.modalRowText}>{PRIORITY_LABEL[priority]}</Text>
                    </Pressable>
                  ))}
                </>
              )}
              {bulkPicker === 'assignee' && (
                <>
                  <Pressable
                    style={styles.modalRow}
                    onPress={() => {
                      void runBulkAction('updated', (cardId) =>
                        apiClient.work.cards.assign.mutate({
                          cardId,
                          assigneeIds: [],
                        }),
                      );
                    }}
                  >
                    <Text style={styles.modalRowText}>Unassign</Text>
                  </Pressable>
                  {people.map((member) => (
                    <Pressable
                      key={member.userId}
                      style={styles.modalRow}
                      onPress={() => {
                        void runBulkAction('updated', (cardId) =>
                          apiClient.work.cards.assign.mutate({
                            cardId,
                            assigneeIds: [member.userId],
                          }),
                        );
                      }}
                    >
                      <Text style={styles.modalRowText}>{personOf(member.userId).label}</Text>
                    </Pressable>
                  ))}
                </>
              )}
            </ScrollView>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setBulkPicker(null);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={addingList}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setAddingList(false);
        }}
      >
        <KeyboardAvoidingView
          style={styles.avoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setAddingList(false);
            }}
          >
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>Add a list</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="e.g. In review"
                placeholderTextColor={colors.inkFaint.hex}
                value={newListName}
                onChangeText={setNewListName}
                autoFocus
              />
              {createList.isError && (
                <Text style={styles.modalError} accessibilityRole="alert">
                  {apiErrorOf(createList.error)?.error.message ?? 'The list was not created.'}
                </Text>
              )}
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalPrimaryButton}
                  disabled={createList.isPending || newListName.trim().length === 0}
                  onPress={() => {
                    createList.mutate(newListName.trim());
                  }}
                >
                  <Text style={styles.modalPrimaryButtonText}>Add list</Text>
                </Pressable>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    setAddingList(false);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={listOptionsFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setListOptionsFor(null);
        }}
      >
        <KeyboardAvoidingView
          style={styles.avoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              setListOptionsFor(null);
            }}
          >
            <Pressable style={styles.modalCard} onPress={() => undefined}>
              <Text style={styles.modalTitle}>List options</Text>
              <TextInput
                style={styles.modalInput}
                placeholder="List name"
                placeholderTextColor={colors.inkFaint.hex}
                value={optionsName}
                onChangeText={setOptionsName}
              />
              <TextInput
                style={styles.modalInput}
                placeholder="WIP limit (optional, advisory only)"
                placeholderTextColor={colors.inkFaint.hex}
                value={optionsWip}
                onChangeText={setOptionsWip}
                keyboardType="number-pad"
              />
              {optionsError !== null && (
                <Text style={styles.modalError} accessibilityRole="alert">
                  {apiErrorOf(optionsError)?.error.message ?? 'The list was not updated.'}
                </Text>
              )}
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalPrimaryButton}
                  disabled={updateList.isPending || optionsName.trim().length === 0}
                  onPress={() => {
                    if (listOptionsFor === null) return;
                    const parsed = Number.parseInt(optionsWip, 10);
                    updateList.mutate({
                      listId: listOptionsFor.listId,
                      name: optionsName.trim(),
                      // An empty box means "no limit" (null), not zero — zero would
                      // render the column as permanently over its limit.
                      wipLimit: optionsWip.trim() === '' || Number.isNaN(parsed) ? null : parsed,
                    });
                  }}
                >
                  <Text style={styles.modalPrimaryButtonText}>Save</Text>
                </Pressable>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    setListOptionsFor(null);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
              <Pressable
                style={styles.modalDangerRow}
                disabled={archiveList.isPending}
                onPress={() => {
                  if (listOptionsFor !== null) archiveList.mutate(listOptionsFor.listId);
                }}
              >
                <Text style={styles.modalDangerText}>Archive this list</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={archivedOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setArchivedOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setArchivedOpen(false);
          }}
        >
          <Pressable style={styles.archivedModalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Archived</Text>
            <Text style={styles.archivedHint}>
              Archiving hides something from the board without deleting it — a card keeps its
              number, comments and history. Restore one to bring it back.
            </Text>
            {archivedOpen && (
              <ScrollView style={styles.archivedScroll}>
                <ArchivedCardsList boardId={boardId} />
                <ArchivedListsList boardId={boardId} />
              </ScrollView>
            )}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setArchivedOpen(false);
              }}
            >
              <Text style={styles.modalDoneText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * Archived cards, and the way back — ported from
 * `apps/web/src/features/work/archived-cards-dialog.tsx`'s
 * `ArchivedCardsList`. Fetched only while `board/[boardId].tsx`'s Archived
 * modal is OPEN (that file's own `{archivedOpen && (...)}` guard), the same
 * reasoning web's own header gives: a rarely-visited list is not worth a
 * query on every board mount.
 */
function ArchivedCardsList({ boardId }: { readonly boardId: string }) {
  const queryClient = useQueryClient();
  const archived = useQuery({
    queryKey: archivedCardsQueryKey(boardId),
    queryFn: async () => {
      const rows = wire(await apiClient.work.cards.list.query({ boardId, includeArchived: true }));
      return rows.filter((card) => card.archivedAt !== null);
    },
  });

  const restore = useMutation({
    mutationFn: (cardId: string) =>
      apiClient.work.cards.archive.mutate({ cardId, archived: false }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      ]);
    },
  });

  const rows = archived.data ?? [];

  return (
    <View style={styles.archivedSection}>
      <Text style={styles.archivedSectionTitle}>Cards</Text>
      {archived.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {archived.isError && (
        <Text style={styles.modalError} accessibilityRole="alert">
          {apiErrorOf(archived.error)?.error.message ?? 'Could not load archived cards.'}
        </Text>
      )}
      {rows.length === 0 && !archived.isPending && (
        <Text style={styles.sectionEmptyHint}>No archived cards.</Text>
      )}
      {rows.map((card) => (
        <View key={card.cardId} style={styles.archivedRow}>
          <View style={styles.archivedRowInfo}>
            <Text style={styles.archivedRowTitle} numberOfLines={1}>
              {card.title}
            </Text>
            <Text style={styles.archivedRowSubtitle}>{card.reference}</Text>
          </View>
          <Pressable
            disabled={restore.isPending && restore.variables === card.cardId}
            onPress={() => {
              restore.mutate(card.cardId);
            }}
          >
            <Text style={styles.archivedRestoreText}>Restore</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/**
 * Archived columns, and the way back — ported from
 * `archived-cards-dialog.tsx`'s `ArchivedListsList`. Restoring is
 * deliberately not gated on the list being empty: the occupancy check
 * exists to stop cards being STRANDED by an archive, and applying it in
 * reverse would refuse exactly the columns worth restoring.
 */
function ArchivedListsList({ boardId }: { readonly boardId: string }) {
  const queryClient = useQueryClient();
  const archived = useQuery({
    queryKey: archivedListsQueryKey(boardId),
    queryFn: async () =>
      wire(await apiClient.work.lists.list.query({ boardId, archivedOnly: true })),
  });

  const restore = useMutation({
    mutationFn: (listId: string) =>
      apiClient.work.lists.archive.mutate({ listId, archived: false }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: listsQueryKey(boardId) }),
        queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
      ]);
    },
  });

  const rows = archived.data ?? [];

  return (
    <View style={styles.archivedSection}>
      <Text style={styles.archivedSectionTitle}>Lists</Text>
      {archived.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {archived.isError && (
        <Text style={styles.modalError} accessibilityRole="alert">
          {apiErrorOf(archived.error)?.error.message ?? 'Could not load archived lists.'}
        </Text>
      )}
      {rows.length === 0 && !archived.isPending && (
        <Text style={styles.sectionEmptyHint}>No archived lists.</Text>
      )}
      {rows.map((list) => (
        <View key={list.listId} style={styles.archivedRow}>
          <View style={styles.archivedRowInfo}>
            <Text style={styles.archivedRowTitle} numberOfLines={1}>
              {list.name}
            </Text>
            <Text style={styles.archivedRowSubtitle}>
              {list.cardCount === 0
                ? 'No cards'
                : `${String(list.cardCount)} card${list.cardCount === 1 ? '' : 's'}`}
            </Text>
          </View>
          <Pressable
            disabled={restore.isPending && restore.variables === list.listId}
            onPress={() => {
              restore.mutate(list.listId);
            }}
          >
            <Text style={styles.archivedRestoreText}>Restore</Text>
          </Pressable>
        </View>
      ))}
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
  /* 36 px matches TopBar icon height — the back button text is vertically
     centred in the same horizontal band as the global icons on the right. */
  backRow: {
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  /* Below the TopBar zone — no overlap possible with the icon cluster. */
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  archivedButton: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  archivedButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
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
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 14,
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
  tabCountWarning: {
    fontWeight: '700',
    color: colors.warning.hex,
  },
  addListTab: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderStyle: 'dashed',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addListTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accent.hex,
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
  addCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 12,
  },
  addCardInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  addCardButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addCardButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    fontSize: 12,
    color: colors.danger.hex,
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 10,
    borderRadius: radiusCard,
    borderWidth: 1,
    borderColor: colors.accent.hex + '40',
    backgroundColor: colors.surfaceRaised.hex,
  },
  bulkBarCount: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  bulkBarActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
  },
  bulkBarButton: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    backgroundColor: colors.surfaceSunken.hex,
  },
  bulkBarButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  bulkBarSpinner: {
    marginLeft: 'auto',
  },
  bulkPickerList: {
    maxHeight: 320,
  },
  avoider: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 4,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 12,
  },
  modalError: {
    fontSize: 13,
    color: colors.danger.hex,
    marginBottom: 8,
  },
  archivedModalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 4,
    height: '80%',
  },
  archivedHint: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginBottom: 8,
  },
  archivedScroll: {
    flex: 1,
  },
  archivedSection: {
    marginTop: 12,
    gap: 4,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
  },
  archivedSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  archivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  archivedRowInfo: {
    flex: 1,
  },
  archivedRowTitle: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  archivedRowSubtitle: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  archivedRestoreText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  sectionEmptyHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingVertical: 4,
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
  modalDoneText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    marginBottom: 10,
  },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSecondaryButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  modalDangerRow: {
    paddingTop: 16,
    alignItems: 'center',
  },
  modalDangerText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
