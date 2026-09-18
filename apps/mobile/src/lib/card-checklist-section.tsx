import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import {
  MY_TASKS_QUERY_KEY,
  boardCardsQueryKey,
  cardQueryKey,
  checklistsQueryKey,
  type Checklist,
} from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * Checklists on a card — `apps/web`'s `ChecklistSection`, the first
 * interactive checklist on native (`card-row.tsx`'s own badge, and the
 * badge row above, have always been COUNT-only, `checklistDone/
 * checklistTotal` read straight off `CardDetail`/`CardSummary`).
 *
 * **Every mutation invalidates the card AND the board's card list, not
 * just the checklist query** — ticking an item changes `checklistDone`/
 * `checklistTotal`, which both `card/[cardId].tsx`'s own badge row and
 * `board/[boardId].tsx`'s `CardRow` render. The server RECOMPUTES those
 * counters inside the writing transaction rather than incrementing them
 * (`counters.ts`), precisely so the number is never a guess — a client
 * that forgot to refetch would undo that by showing a stale one, and a
 * wrong badge looks exactly like a correct one. _(The same staleness this
 * comment fixes for checklists still applies to status/priority/
 * assignees/labels/sprint above: those sections predate `board/
 * [boardId].tsx` rendering `CardRow` at all, from back when `use-update-
 * card.ts`'s own header could honestly say "mobile has no board view
 * yet." That claim is no longer true and none of those five sections'
 * invalidation sets were widened to match — a real, separate follow-up,
 * named here rather than silently left for whoever next touches one of
 * them to rediscover.)_
 *
 * **Adding a checklist or an item is NOT optimistic; ticking and deleting
 * ARE** — matching web's own split exactly, for the same reason: an item
 * id comes from the server, and a row that cannot be deleted until the
 * refetch lands is worse than one that appears a moment late (the same
 * "no fake reference" call `board/[boardId].tsx`'s own Add Card makes).
 * Ticking a box, though, has to be instant — a checkbox that waits for a
 * round trip is the canonical "this app feels slow" — so `toggleItem`
 * patches the checklist query directly before the mutation resolves, and
 * rolls back to the snapshot on failure.
 */
export function ChecklistSection({
  cardId,
  boardId,
  canEdit,
}: {
  readonly cardId: CardId;
  readonly boardId: string;
  readonly canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [newChecklistName, setNewChecklistName] = useState('');
  const [addingItemFor, setAddingItemFor] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState('');

  const checklists = useQuery({
    queryKey: checklistsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.checklists.list.query({ cardId })),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: checklistsQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
      queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
    ]);

  const createChecklist = useMutation({
    mutationFn: (name: string) => apiClient.work.checklists.create.mutate({ cardId, name }),
    onSuccess: () => {
      setNewChecklistName('');
    },
    onSettled: refresh,
  });

  const deleteChecklist = useMutation({
    mutationFn: (checklistId: string) => apiClient.work.checklists.delete.mutate({ checklistId }),
    onSettled: refresh,
  });

  const toggleItem = useMutation({
    mutationFn: (input: { itemId: string; text: string; done: boolean }) =>
      apiClient.work.checklists.updateItem.mutate(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: checklistsQueryKey(cardId) });
      const previous = queryClient.getQueryData<readonly Checklist[]>(checklistsQueryKey(cardId));
      queryClient.setQueryData<readonly Checklist[]>(checklistsQueryKey(cardId), (current) =>
        (current ?? []).map((checklist) => ({
          ...checklist,
          items: checklist.items.map((item) =>
            item.itemId === input.itemId ? { ...item, done: input.done } : item,
          ),
        })),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context !== undefined) {
        queryClient.setQueryData(checklistsQueryKey(cardId), context.previous);
      }
    },
    onSettled: refresh,
  });

  const addItem = useMutation({
    mutationFn: (input: { checklistId: string; text: string }) =>
      apiClient.work.checklists.addItem.mutate(input),
    onSuccess: () => {
      setNewItemText('');
      setAddingItemFor(null);
    },
    onSettled: refresh,
  });

  const deleteItem = useMutation({
    mutationFn: (itemId: string) => apiClient.work.checklists.deleteItem.mutate({ itemId }),
    onMutate: async (itemId) => {
      await queryClient.cancelQueries({ queryKey: checklistsQueryKey(cardId) });
      const previous = queryClient.getQueryData<readonly Checklist[]>(checklistsQueryKey(cardId));
      queryClient.setQueryData<readonly Checklist[]>(checklistsQueryKey(cardId), (current) =>
        (current ?? []).map((checklist) => ({
          ...checklist,
          items: checklist.items.filter((item) => item.itemId !== itemId),
        })),
      );
      return { previous };
    },
    onError: (_error, _itemId, context) => {
      if (context !== undefined) {
        queryClient.setQueryData(checklistsQueryKey(cardId), context.previous);
      }
    },
    onSettled: refresh,
  });

  const anyError =
    createChecklist.error ??
    deleteChecklist.error ??
    toggleItem.error ??
    addItem.error ??
    deleteItem.error;

  return (
    <Section label="Checklists">
      {(checklists.data ?? []).map((checklist) => {
        const done = checklist.items.filter((item) => item.done).length;
        return (
          <View key={checklist.checklistId} style={styles.checklistGroup}>
            <View style={styles.checklistHeader}>
              <Text style={styles.checklistName}>{checklist.name}</Text>
              <Text style={styles.checklistCount}>
                {done}/{checklist.items.length}
              </Text>
              {canEdit && (
                <Pressable
                  style={styles.checklistDeleteButton}
                  onPress={() => {
                    deleteChecklist.mutate(checklist.checklistId);
                  }}
                >
                  <Text style={styles.checklistDeleteText}>Delete</Text>
                </Pressable>
              )}
            </View>

            {checklist.items.length > 0 && (
              <View style={styles.progressBarTrack}>
                <ProgressBar percent={Math.round((done / checklist.items.length) * 100)} />
              </View>
            )}

            {checklist.items.map((item) => (
              <View key={item.itemId} style={styles.checklistItemRow}>
                <Pressable
                  style={[
                    styles.checklistBox,
                    item.done && styles.checklistBoxDone,
                    !canEdit && styles.checklistBoxDisabled,
                  ]}
                  disabled={!canEdit}
                  onPress={() => {
                    toggleItem.mutate({ itemId: item.itemId, text: item.text, done: !item.done });
                  }}
                >
                  {item.done && <Text style={styles.checklistBoxCheck}>✓</Text>}
                </Pressable>
                <Text style={[styles.checklistItemText, item.done && styles.checklistItemTextDone]}>
                  {item.text}
                </Text>
                {canEdit && (
                  <Pressable
                    onPress={() => {
                      deleteItem.mutate(item.itemId);
                    }}
                    hitSlop={8}
                  >
                    <Text style={styles.checklistItemRemove}>✕</Text>
                  </Pressable>
                )}
              </View>
            ))}

            {canEdit &&
              (addingItemFor === checklist.checklistId ? (
                <View style={styles.addCardRow}>
                  <TextInput
                    style={styles.addCardInput}
                    placeholder="Add an item"
                    placeholderTextColor={colors.inkFaint.hex}
                    value={newItemText}
                    onChangeText={setNewItemText}
                    autoFocus
                    onSubmitEditing={() => {
                      const value = newItemText.trim();
                      if (value === '') return;
                      addItem.mutate({ checklistId: checklist.checklistId, text: value });
                    }}
                  />
                  <Pressable
                    style={styles.addCardButton}
                    disabled={addItem.isPending}
                    onPress={() => {
                      const value = newItemText.trim();
                      if (value === '') return;
                      addItem.mutate({ checklistId: checklist.checklistId, text: value });
                    }}
                  >
                    <Text style={styles.addCardButtonText}>Add</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => {
                    setNewItemText('');
                    setAddingItemFor(checklist.checklistId);
                  }}
                >
                  <Text style={styles.checklistAddItemText}>+ Add an item</Text>
                </Pressable>
              ))}
          </View>
        );
      })}

      {canEdit && (
        <View style={styles.addCardRow}>
          <TextInput
            style={styles.addCardInput}
            placeholder="New checklist"
            placeholderTextColor={colors.inkFaint.hex}
            value={newChecklistName}
            onChangeText={setNewChecklistName}
            onSubmitEditing={() => {
              const value = newChecklistName.trim();
              if (value !== '') createChecklist.mutate(value);
            }}
          />
          <Pressable
            style={styles.addCardButton}
            disabled={createChecklist.isPending || newChecklistName.trim().length === 0}
            onPress={() => {
              const value = newChecklistName.trim();
              if (value !== '') createChecklist.mutate(value);
            }}
          >
            <Text style={styles.addCardButtonText}>Add</Text>
          </Pressable>
        </View>
      )}

      {anyError !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(anyError)?.error.message ?? 'The checklist was not saved.'}
        </Text>
      )}
    </Section>
  );
}

function ProgressBar({ percent }: { readonly percent: number }) {
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  const widthStyle = { width: `${percent}%` } as const;
  return (
    <View style={styles.progressBarTrack}>
      <View style={[styles.progressBarFill, widthStyle]} />
    </View>
  );
}
