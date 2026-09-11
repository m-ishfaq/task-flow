import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Columns3, Plus } from 'lucide-react';
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
  /**
   * `boards.list`'s per-board `capabilities.update` — `lists.create` is
   * `board:update` (`list-column.tsx`'s own `ListColumnProps.canManage`
   * comment has the fuller reasoning). Both components below render
   * nothing when this is false, rather than a button that always answers
   * FORBIDDEN (Phase 15 §1's sweep).
   */
  readonly canManage: boolean;
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
export function AddListColumn({ orgId, boardId, canManage }: AddListProps) {
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

  if (!canManage) return null;

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
          <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
          Add list
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
 *
 * The outer box matches `Empty`'s own visual language (dashed `rounded-xl`,
 * the icon-in-a-ringed-disc, the same radial accent glow) rather than a plain
 * bordered rectangle — this is the same "nothing here" moment as My Tasks' or
 * a board's own List view, just with a real action attached instead of only
 * text, so it is not `Empty` itself (whose `action` slot is sized for one
 * button, not a create-list-column form that needs its own width and
 * `Escape`-to-cancel state) but is styled to read as the same pattern.
 */
export function EmptyBoard({ orgId, boardId, canManage }: AddListProps) {
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
    <div className="flex h-full items-start justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong/60 bg-[radial-gradient(420px_200px_at_50%_0%,oklch(58%_0.17_285/7%),transparent_70%)] bg-surface-sunken/30 p-10 text-center">
        <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-surface-raised text-ink-faint ring-1 ring-line/50">
          <Columns3 aria-hidden="true" className="size-5" strokeWidth={1.75} />
        </span>
        <div>
          <p className="text-[15px] font-semibold text-ink">This board has no lists yet</p>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-muted">
            {canManage
              ? 'Lists are the columns cards move between. Start with the usual three, or name your own.'
              : 'Lists are the columns cards move between. An admin or owner needs to set them up.'}
          </p>
        </div>

        {canManage && (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={scaffold}>
              {busy ? 'Creating…' : 'Add Todo, Doing, Done'}
            </Button>
            <AddListColumn orgId={orgId} boardId={boardId} canManage={canManage} />
          </div>
        )}

        {create.isError && <ErrorText error={create.error} />}
      </div>
    </div>
  );
}
