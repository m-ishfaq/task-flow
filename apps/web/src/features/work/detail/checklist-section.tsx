import { useState } from 'react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, SquareCheck, X } from 'lucide-react';
import type { BoardId, CardId, ChecklistId, ChecklistItemId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { useToast } from '../../../lib/toast-context.js';
import { cn } from '../../../lib/cn.js';
import { Button, Input } from '../../../components/primitives.js';
import {
  checklistsQuery,
  invalidateCard,
  patchChecklistCounters,
  patchChecklists,
  type Checklist,
} from '../api.js';

/**
 * Checklists on a card.
 *
 * Every mutation invalidates the CARD as well as the checklist query, because
 * ticking an item changes `checklistDone` / `checklistTotal` on the card row —
 * which the board tile renders as a badge. The server recomputes those counters
 * inside the writing transaction rather than incrementing them (`counters.ts`),
 * precisely so the number is never a guess; a client that forgot to refetch the
 * board would undo that by showing a stale one, and a wrong badge looks exactly
 * like a correct one.
 */

export interface ChecklistSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  /** `card:update` — a viewer/commenter-relation guest sees checked items, never a checkbox to click. */
  readonly canEdit: boolean;
}

export function ChecklistSection({ orgId, boardId, cardId, canEdit }: ChecklistSectionProps) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const toast = useToast();
  const checklists = useQuery(checklistsQuery(orgId, cardId));
  const [name, setName] = useState('');

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.checklists(orgId, cardId) }),
      invalidateCard(queryClient, orgId, cardId, boardId),
    ]);
  };

  const createList = useMutation({
    mutationFn: (value: string) => api.work.checklists.create.mutate({ cardId, name: value }),
    onSuccess: () => {
      setName('');
    },
    onError: (error) => {
      toast.failure('The checklist was not created', error);
    },
    onSettled: async () => {
      await refresh();
    },
  });

  /**
   * Ticking a box.
   *
   * The one interaction here that has to be instant: a checkbox that waits for a
   * round trip before it fills in is the canonical example of an app feeling
   * slow, and someone working through a list of eight items pays for it eight
   * times.
   *
   * It patches THREE places, because the state is rendered in three: the item
   * itself, the card's `checklistDone` counter behind the panel, and the same
   * counter on the board tile.
   */
  const toggleItem = useMutation({
    mutationFn: (input: { itemId: ChecklistItemId; text: string; done: boolean }) =>
      api.work.checklists.updateItem.mutate(input),

    ...optimistic<{ itemId: ChecklistItemId; text: string; done: boolean }>({
      keys: [
        keys.checklists(orgId, cardId),
        keys.card(orgId, cardId),
        keys.cardsOfBoard(orgId, boardId),
      ],
      patch: (client, input) => {
        patchChecklists(client, orgId, cardId, (lists) =>
          lists.map((checklist) => ({
            ...checklist,
            items: checklist.items.map((item) =>
              item.itemId === input.itemId ? { ...item, done: input.done } : item,
            ),
          })),
        );
        patchChecklistCounters(client, orgId, boardId, cardId, {
          done: input.done ? 1 : -1,
          total: 0,
        });
      },
      failureTitle: 'The item was not updated',
    }),
  });

  const addItem = useMutation({
    mutationFn: (input: { checklistId: ChecklistId; text: string }) =>
      api.work.checklists.addItem.mutate(input),
    /* Not optimistic: the item id comes from the server and the row needs one to
       be deletable. An invented id would make the ✕ next to a just-added item
       delete nothing until the refetch replaced it — the same reason the card
       tile does not fake a `WEB-142`. The counter still moves immediately, since
       that number is a count and not an identity. */
    onSettled: async () => {
      await refresh();
    },
    onError: (error) => {
      toast.failure('The item was not added', error);
    },
  });

  const removeItem = useMutation({
    mutationFn: (itemId: ChecklistItemId) => api.work.checklists.deleteItem.mutate({ itemId }),

    ...optimistic<ChecklistItemId>({
      keys: [
        keys.checklists(orgId, cardId),
        keys.card(orgId, cardId),
        keys.cardsOfBoard(orgId, boardId),
      ],
      patch: (client, itemId) => {
        /* The removed item's own `done` decides the counter delta, so it is READ
           first and dropped second. Deleting a ticked item lowers both numbers;
           deleting an unticked one lowers only the total. Getting that branch
           wrong produces a badge nothing ever corrects — which is exactly why
           the server recomputes rather than increments.

           Reading it into a variable the filter assigns would be the shorter
           version and is a trap: TypeScript cannot see a write from inside a
           callback, narrows the flag to `false`, and the delta becomes a
           constant the compiler is happy with. */
        const cached = client.getQueryData<readonly Checklist[]>(keys.checklists(orgId, cardId));
        const removed = (cached ?? [])
          .flatMap((checklist) => checklist.items)
          .find((item) => item.itemId === itemId);

        patchChecklists(client, orgId, cardId, (lists) =>
          lists.map((checklist) => ({
            ...checklist,
            items: checklist.items.filter((item) => item.itemId !== itemId),
          })),
        );

        /* Nothing moves when the item was not in the cache: the row cannot have
           been clicked, so a delta here would be inventing a change. */
        patchChecklistCounters(client, orgId, boardId, cardId, {
          done: removed?.done === true ? -1 : 0,
          total: removed === undefined ? 0 : -1,
        });
      },
      failureTitle: 'The item was not deleted',
    }),
  });

  const removeList = useMutation({
    mutationFn: (checklistId: ChecklistId) => api.work.checklists.delete.mutate({ checklistId }),
    onError: (error) => {
      toast.failure('The checklist was not deleted', error);
    },
    onSettled: async () => {
      await refresh();
    },
  });

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <SquareCheck aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Checklists
      </h3>

      {(checklists.data ?? []).map((checklist) => {
        const done = checklist.items.filter((item) => item.done).length;

        return (
          <div key={checklist.checklistId} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-medium text-ink">{checklist.name}</h4>
              <span className="text-xs text-ink-faint">
                {done}/{checklist.items.length}
              </span>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-5 px-1 text-xs"
                  onClick={() => {
                    removeList.mutate(checklist.checklistId as ChecklistId);
                  }}
                >
                  Delete
                </Button>
              )}
            </div>

            <ul className="space-y-0.5">
              {checklist.items.map((item) => (
                <li key={item.itemId} className="group flex items-center gap-2">
                  <Checkbox.Root
                    checked={item.done}
                    disabled={!canEdit}
                    onCheckedChange={(checked) => {
                      toggleItem.mutate({
                        itemId: item.itemId as ChecklistItemId,
                        // `updateItem` handles renaming AND ticking in one call,
                        // so the text has to travel with the checkbox state.
                        text: item.text,
                        done: checked === true,
                      });
                    }}
                    className="flex size-4 shrink-0 items-center justify-center rounded border border-line bg-surface-sunken data-[state=checked]:bg-accent disabled:opacity-60"
                  >
                    <Checkbox.Indicator className="text-accent-ink">
                      <Check aria-hidden="true" className="size-3" strokeWidth={3} />
                    </Checkbox.Indicator>
                  </Checkbox.Root>

                  <span
                    className={cn('flex-1 text-xs', item.done && 'text-ink-faint line-through')}
                  >
                    {item.text}
                  </span>

                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Delete "${item.text}"`}
                      onClick={() => {
                        removeItem.mutate(item.itemId as ChecklistItemId);
                      }}
                      className="text-ink-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                    >
                      <X aria-hidden="true" className="size-3.5" strokeWidth={2} />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {canEdit && (
              <AddItemForm
                onAdd={(text) => {
                  addItem.mutate({ checklistId: checklist.checklistId as ChecklistId, text });
                }}
              />
            )}
          </div>
        );
      })}

      {canEdit && (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const value = name.trim();
            if (value !== '') createList.mutate(value);
          }}
        >
          <Input
            aria-label="New checklist name"
            placeholder="New checklist"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" disabled={createList.isPending || name.trim() === ''}>
            Add
          </Button>
        </form>
      )}

      {/* No inline error rows. Every mutation here reports through a toast, which
          also survives the panel being closed by the failure it is reporting. */}
    </section>
  );
}

function AddItemForm({ onAdd }: { readonly onAdd: (text: string) => void }) {
  const [text, setText] = useState('');

  return (
    <form
      className="flex gap-1.5 pl-6"
      onSubmit={(event) => {
        event.preventDefault();
        const value = text.trim();
        if (value === '') return;
        onAdd(value);
        setText('');
      }}
    >
      <Input
        aria-label="New checklist item"
        placeholder="Add an item"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        className="h-6 text-xs"
      />
    </form>
  );
}
