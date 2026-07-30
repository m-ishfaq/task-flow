import { useState } from 'react';
import * as Checkbox from '@radix-ui/react-checkbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ChecklistId, ChecklistItemId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { cn } from '../../../lib/cn.js';
import { Button, Input } from '../../../components/primitives.js';
import { ErrorText } from '../../../components/error-view.js';
import { checklistsQuery, invalidateCard } from '../api.js';

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
}

export function ChecklistSection({ orgId, boardId, cardId }: ChecklistSectionProps) {
  const queryClient = useQueryClient();
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
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });

  const toggleItem = useMutation({
    mutationFn: (input: { itemId: ChecklistItemId; text: string; done: boolean }) =>
      api.work.checklists.updateItem.mutate(input),
    onSuccess: refresh,
  });

  const addItem = useMutation({
    mutationFn: (input: { checklistId: ChecklistId; text: string }) =>
      api.work.checklists.addItem.mutate(input),
    onSuccess: refresh,
  });

  const removeItem = useMutation({
    mutationFn: (itemId: ChecklistItemId) => api.work.checklists.deleteItem.mutate({ itemId }),
    onSuccess: refresh,
  });

  const removeList = useMutation({
    mutationFn: (checklistId: ChecklistId) => api.work.checklists.delete.mutate({ checklistId }),
    onSuccess: refresh,
  });

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Checklists</h3>

      {(checklists.data ?? []).map((checklist) => {
        const done = checklist.items.filter((item) => item.done).length;

        return (
          <div key={checklist.checklistId} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-medium text-ink">{checklist.name}</h4>
              <span className="text-[11px] text-ink-faint">
                {done}/{checklist.items.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-5 px-1 text-[11px]"
                onClick={() => {
                  removeList.mutate(checklist.checklistId as ChecklistId);
                }}
              >
                Delete
              </Button>
            </div>

            <ul className="space-y-0.5">
              {checklist.items.map((item) => (
                <li key={item.itemId} className="group flex items-center gap-2">
                  <Checkbox.Root
                    checked={item.done}
                    onCheckedChange={(checked) => {
                      toggleItem.mutate({
                        itemId: item.itemId as ChecklistItemId,
                        // `updateItem` handles renaming AND ticking in one call,
                        // so the text has to travel with the checkbox state.
                        text: item.text,
                        done: checked === true,
                      });
                    }}
                    className="flex size-4 shrink-0 items-center justify-center rounded border border-line bg-surface-sunken data-[state=checked]:bg-accent"
                  >
                    <Checkbox.Indicator className="text-[10px] text-accent-ink">
                      ✓
                    </Checkbox.Indicator>
                  </Checkbox.Root>

                  <span
                    className={cn('flex-1 text-xs', item.done && 'text-ink-faint line-through')}
                  >
                    {item.text}
                  </span>

                  <button
                    type="button"
                    aria-label={`Delete "${item.text}"`}
                    onClick={() => {
                      removeItem.mutate(item.itemId as ChecklistItemId);
                    }}
                    className="text-[11px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>

            <AddItemForm
              onAdd={(text) => {
                addItem.mutate({ checklistId: checklist.checklistId as ChecklistId, text });
              }}
            />
          </div>
        );
      })}

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

      {createList.isError && <ErrorText error={createList.error} />}
      {toggleItem.isError && <ErrorText error={toggleItem.error} />}
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
