import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { Button, Input } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';

/**
 * Creating a list, and the empty state of a brand-new board.
 *
 * This is the control whose absence made the whole product unusable: cards are
 * added from INSIDE a list column, so a board with no lists rendered an empty
 * strip with no way forward at all. `work.lists.create` existed, was
 * permissioned and tested, and simply had no button.
 *
 * The lesson is about how the gap was invisible: every automated check was
 * green, because a route with no caller breaks nothing. Coverage of the API
 * says nothing about whether the API is REACHABLE.
 */

export interface AddListProps {
  readonly orgId: string;
  readonly boardId: BoardId;
}

function useCreateList(orgId: string, boardId: BoardId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) => api.work.lists.create.mutate({ boardId, name, wipLimit: null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) });
    },
  });
}

/** The trailing "+ Add list" column, alongside the existing ones. */
export function AddListColumn({ orgId, boardId }: AddListProps) {
  const create = useCreateList(orgId, boardId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const submit = () => {
    const value = name.trim();
    if (value === '') return;
    create.mutate(value, {
      onSuccess: () => {
        setName('');
        // Stays open: adding several columns in a row is the normal way a board
        // gets set up, and closing after each one makes that four extra clicks.
      },
    });
  };

  if (!open) {
    return (
      <div className="w-72 shrink-0">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            setOpen(true);
          }}
        >
          + Add list
        </Button>
      </div>
    );
  }

  return (
    <form
      className="w-72 shrink-0 space-y-2 rounded-card bg-surface-sunken p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        aria-label="List name"
        placeholder="e.g. In review"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        className="h-8 text-xs"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
          Add list
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
      {create.isError && <ErrorText error={create.error} />}
    </form>
  );
}

/**
 * What a board shows before it has any lists.
 *
 * Offers the three-column default outright. A blank board with a single "+ Add
 * list" is technically complete and practically a dead end — the person who just
 * created a board wants a board, not a column-authoring exercise.
 *
 * The lists are created in SEQUENCE, not in parallel. Their rank is derived from
 * the existing lists at insert time, so three concurrent creates would race for
 * the same position and land in an arbitrary order — the one thing a Todo →
 * Doing → Done row must not do.
 */
export function EmptyBoard({ orgId, boardId }: AddListProps) {
  const create = useCreateList(orgId, boardId);
  const [busy, setBusy] = useState(false);

  const scaffold = () => {
    setBusy(true);
    void (async () => {
      try {
        for (const name of ['Todo', 'Doing', 'Done']) {
          await create.mutateAsync(name);
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="flex h-full items-start p-3">
      <div className="flex w-full max-w-md flex-col gap-3 rounded border border-dashed border-line p-6">
        <div>
          <p className="text-sm font-medium text-ink">This board has no lists yet</p>
          <p className="mt-1 text-xs text-ink-muted">
            Lists are the columns cards move between. Start with the usual three, or name your own.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={scaffold}>
            {busy ? 'Creating…' : 'Add Todo, Doing, Done'}
          </Button>
          <AddListColumn orgId={orgId} boardId={boardId} />
        </div>

        {create.isError && <ErrorText error={create.error} />}
      </div>
    </div>
  );
}
