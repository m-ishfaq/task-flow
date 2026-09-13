import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import { parse } from '@taskflow/filter';
import { unsafeAsId, type BoardId, type CardId, type ListId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useOptimistic } from '../../lib/optimistic.js';
import { useToast } from '../../lib/toast-context.js';
import { cn } from '../../lib/cn.js';
import { Button, Input } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { searchResultsQuery } from '../search/api.js';
import { patchLists, type ListSummary } from './api.js';
import { CardQuickView } from './card-quick-view.js';
import { buildDuplicateQuery, DUPLICATE_MATCH_LIMIT } from './duplicate-detect.js';
import { flowTintGradient } from './flow-tint.js';

/**
 * One column of the board.
 *
 * Registered as a droppable in its own right, not just as a container of
 * sortable cards. Without that, an EMPTY list has nothing to drop onto and
 * cannot receive a card at all — the most common way a kanban implementation
 * ends up with a column you can never move work into.
 *
 * The WIP limit is displayed and never enforced. §10.1: blocking someone from
 * recording work that is already in progress makes people stop using the board,
 * not stop the work. The count going red is the whole intervention.
 *
 * The section's own `backgroundImage` below is `flowTintGradient`
 * (`flow-tint.ts` — see that file's own header for the full reasoning): a
 * per-column warm wash keyed to rank-order position, not name.
 */

export interface ListColumnProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly list: ListSummary;
  readonly count: number;
  /** Every column, in rank order — the menu needs neighbours to reorder. */
  readonly siblings: readonly ListSummary[];
  readonly children: ReactNode;
  /**
   * `boards.list`'s per-board `capabilities.update` — `lists.update`/
   * `.reorder`/`.archive` are all `board:update`, so `ListMenu` (rename,
   * WIP limit, reorder, archive) is hidden entirely for a caller who lacks
   * it, rather than rendered and left to answer FORBIDDEN (Phase 15 §1's
   * sweep). `AddCard` below is unaffected — creating a card is
   * `card:create`, which a plain Member holds.
   */
  readonly canManage: boolean;
}

export function ListColumn({
  orgId,
  boardId,
  list,
  count,
  siblings,
  canManage,
  children,
}: ListColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: list.listId });
  const overLimit = list.wipLimit !== null && count > list.wipLimit;

  return (
    <section
      ref={setNodeRef}
      aria-label={list.name}
      className={cn(
        'column-container flex max-h-full w-72 shrink-0 flex-col',
        isOver && 'ring-2 ring-accent/50 border-accent/30',
      )}
      style={{ backgroundImage: flowTintGradient(list, siblings) }}
    >
      <header className="column-header justify-between">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{list.name}</h2>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            overLimit ? 'bg-warning/15 text-warning' : 'bg-surface-hover/80 text-ink-faint',
          )}
          title={
            list.wipLimit === null
              ? undefined
              : `WIP limit ${String(list.wipLimit)} — advisory, not enforced`
          }
        >
          {count}
          {list.wipLimit !== null && `/${String(list.wipLimit)}`}
        </span>
        {canManage && <ListMenu orgId={orgId} boardId={boardId} list={list} siblings={siblings} />}
      </header>

      <div className="flex min-h-16 flex-col gap-1.5 overflow-y-auto px-2 pb-2 pt-0.5">
        {children}
      </div>

      <AddCard orgId={orgId} boardId={boardId} listId={list.listId as ListId} />
    </section>
  );
}

/**
 * Rename, set a WIP limit, archive.
 *
 * All three routes existed with no caller. Archiving is offered rather than
 * deleting because that is what the service does: a list holds cards, and
 * `archiveList` hides the column without destroying the work in it.
 *
 * The WIP limit is editable here and enforced nowhere — `moveCard` reports the
 * breach and completes the move. Blocking someone from recording work that is
 * already in progress makes people stop using the board, not stop the work.
 */
function ListMenu({
  orgId,
  boardId,
  list,
  siblings,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly list: ListSummary;
  readonly siblings: readonly ListSummary[];
}) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [wip, setWip] = useState(list.wipLimit === null ? '' : String(list.wipLimit));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) }),
      queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
    ]);

  const update = useMutation({
    mutationFn: (input: { name: string; wipLimit: number | null }) =>
      api.work.lists.update.mutate({ listId: list.listId, ...input }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });

  const archive = useMutation({
    mutationFn: () => api.work.lists.archive.mutate({ listId: list.listId, archived: true }),
    onSuccess: refresh,
  });

  /**
   * Moving a column left or right.
   *
   * Buttons rather than drag, deliberately. Column dragging would have to share
   * the board's existing `DndContext` with card dragging and be told apart by
   * the payload — real risk to the one interaction that is already tested and
   * working, for a refinement §10.4 does not ask for. Buttons are also keyboard
   * operable with no extra work, which a second drag surface would not be.
   *
   * The NEIGHBOUR semantics are the same as cards: `before` is the column it
   * ends up after (the lower rank) and `after` the one it ends up before, so
   * moving left past P means landing between P's own predecessor and P.
   */
  const reorder = useMutation({
    mutationFn: (direction: -1 | 1) => {
      const index = siblings.findIndex((entry) => entry.listId === list.listId);
      const target = index + direction;

      // The caller disables the button at the ends; this is the guard that makes
      // the function safe on its own.
      const beforeList = direction === -1 ? siblings[target - 1] : siblings[target];
      const afterList = direction === -1 ? siblings[target] : siblings[target + 1];

      return api.work.lists.reorder.mutate({
        listId: list.listId,
        beforeListId: beforeList?.listId ?? null,
        afterListId: afterList?.listId ?? null,
      });
    },

    ...optimistic<-1 | 1>({
      /* Only the lists query. The cards are keyed by list and the board draws the
         columns in the order this array arrives, so moving the entry moves the
         whole column with its cards — patching them too would be patching the
         same fact twice. */
      keys: [keys.lists(orgId, boardId)],
      patch: (client, direction) => {
        patchLists(client, orgId, boardId, (current) => {
          /* Re-found in the CACHED array rather than reusing the index computed
             from `siblings`. The two agree today, but `siblings` is a filtered
             prop and a caller that later hides archived columns would make the
             index mean a different row here — which reorders the wrong column
             and looks like a server bug. */
          const from = current.findIndex((entry) => entry.listId === list.listId);
          const to = from + direction;
          if (from === -1 || to < 0 || to >= current.length) return current;

          const next = [...current];
          const [moved] = next.splice(from, 1);
          if (moved === undefined) return current;
          next.splice(to, 0, moved);
          return next;
        });
      },
      failureTitle: 'The list was not moved',
    }),
  });

  const index = siblings.findIndex((entry) => entry.listId === list.listId);

  if (editing) {
    return (
      <form
        className="absolute z-10 mt-24 w-64 space-y-2 rounded border border-line bg-surface-raised p-2 shadow-lg"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number.parseInt(wip, 10);
          update.mutate({
            name: name.trim() === '' ? list.name : name.trim(),
            // An empty box means "no limit", which is null and not zero — zero
            // would render every column as permanently over its limit.
            wipLimit: wip.trim() === '' || Number.isNaN(parsed) ? null : parsed,
          });
        }}
      >
        <Input
          aria-label="List name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="h-7 text-xs"
        />
        <Input
          aria-label="WIP limit"
          type="number"
          min={1}
          placeholder="WIP limit (optional)"
          value={wip}
          onChange={(event) => {
            setWip(event.target.value);
          }}
          className="h-7 text-xs"
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Move list left"
            /* Disabled only at the end of the row, not while pending — the
               column has already moved in the cache, so a second press moves it
               again from where it now is. */
            disabled={index <= 0}
            onClick={() => {
              reorder.mutate(-1);
            }}
          >
            <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={2} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Move list right"
            disabled={index === -1 || index >= siblings.length - 1}
            onClick={() => {
              reorder.mutate(1);
            }}
          >
            <ChevronRight aria-hidden="true" className="size-4" strokeWidth={2} />
          </Button>
        </div>

        <div className="flex gap-1.5">
          <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-danger"
            disabled={archive.isPending}
            onClick={() => {
              archive.mutate();
            }}
          >
            Archive
          </Button>
        </div>
        {update.isError && <ErrorText error={update.error} />}
        {archive.isError && <ErrorText error={archive.error} />}
        {/* Reorder reports through a toast instead: its failure rolls the column
            back on the BOARD, which is behind this menu and may already be
            closed by the time the answer arrives. */}
      </form>
    );
  }

  return (
    <button
      type="button"
      aria-label={`List options for ${list.name}`}
      onClick={() => {
        setEditing(true);
      }}
      className="rounded p-1 text-ink-faint hover:bg-surface-hover hover:text-ink"
    >
      <MoreHorizontal aria-hidden="true" className="size-3.5" strokeWidth={2} />
    </button>
  );
}

/**
 * Adding cards, one after another.
 *
 * ## Why the field clears on SUBMIT and not on success
 *
 * Capturing a backlog is a burst: five cards in fifteen seconds, straight from
 * the head. Clearing on success puts a network round trip between each one, so
 * the second title is typed into a box that still holds the first and then gets
 * wiped when the response lands. The text vanishing mid-word is the single most
 * effective way to stop someone using a board.
 *
 * So the field clears immediately, keeps focus, and a failure puts the title
 * BACK — restored rather than lost, because the alternative is asking someone to
 * retype something they already typed, having told them it was saved.
 *
 * ## Why there is still no optimistic insert
 *
 * Deliberate, and unchanged. The card's REFERENCE — `WEB-142` — is assigned by
 * the server from a per-project counter and is rendered on the tile. A
 * placeholder would have to invent one, and a card number that changes under the
 * reader a moment later is worse than one that appears a moment late. Everything
 * else here is optimistic; the identifier is the one thing a client cannot
 * honestly guess.
 */
/**
 * Duplicate-card detection, layered onto the same input.
 *
 * Purely advisory — the dropdown never blocks or intercepts submission, the
 * same WIP-limit philosophy this file's own header states for the count
 * going red: "blocking someone from recording work already in progress
 * makes people stop using the board, not stop the work," applied to the
 * identical shape of problem for a possible duplicate. Reuses
 * `search.query` exactly as the search page itself calls it — no new
 * backend route, no new permission.
 */
function AddCard({
  orgId,
  boardId,
  listId,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly listId: ListId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [debouncedTitle, setDebouncedTitle] = useState('');
  const [openMatch, setOpenMatch] = useState<CardId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedTitle(title);
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [title]);

  const duplicateQuery = buildDuplicateQuery(debouncedTitle);
  /* Gated on the client's own parse, mirroring `search-page.tsx`'s `sendable`
     check — a title whose literal text breaks TQL syntax (an unbalanced
     quote, a bare "AND") simply shows no dropdown rather than sending a
     query the server would refuse. */
  const duplicateQueryValid = duplicateQuery !== null && parse(duplicateQuery).ok;

  const duplicates = useQuery({
    ...searchResultsQuery(orgId, duplicateQuery ?? ''),
    enabled: duplicateQueryValid && orgId !== '',
  });
  const matches = duplicateQueryValid
    ? (duplicates.data ?? []).slice(0, DUPLICATE_MATCH_LIMIT)
    : [];

  const create = useMutation({
    mutationFn: (value: string) =>
      api.work.cards.create.mutate({ listId, title: value, description: null }),

    onError: (error, value) => {
      /* Restored, and only if the box is still empty. Someone who has already
         started the next card must not have it overwritten by the recovery of
         the previous one — that would turn one lost title into two. */
      setTitle((current) => (current === '' ? value : current));
      toast.failure('The card was not created', error);
    },

    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
    },
  });

  const submit = () => {
    const value = title.trim();
    if (value === '') return;

    setTitle('');
    // Dismissed synchronously rather than waiting out the 250ms debounce, so
    // a submitted title's own matches do not flash on screen for a beat.
    setDebouncedTitle('');
    /* Focus is not automatic here. The input is never unmounted, so it KEEPS
       focus through a submit — but only while the button is not the thing that
       was clicked. Calling it explicitly covers both paths with one line. */
    inputRef.current?.focus();
    create.mutate(value);
  };

  return (
    <div className="relative px-2 pb-2">
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          ref={inputRef}
          aria-label="New card title"
          placeholder="Add a card"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            // Escape abandons the draft and gets out of the way, which is the only
            // way to leave this field without either saving or clearing it by hand.
            if (event.key === 'Escape') {
              setTitle('');
              setDebouncedTitle('');
              event.currentTarget.blur();
            }
          }}
          className="h-7 text-xs"
        />
        {/* Not disabled while pending — the whole point is that the next title can
            be typed and submitted before the previous one has landed. */}
        <Button type="submit" size="sm" disabled={title.trim() === ''}>
          <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
          Add
        </Button>
      </form>

      {matches.length > 0 && (
        // Opens UPWARD, not downward — `AddCard` sits at the BOTTOM of the
        // list, so a dropdown anchored `top-full` floats into the empty
        // space below the column (or gets clipped by it), disconnected from
        // the cards it's actually claiming to match. `bottom-full` overlays
        // it on the cards already in view above the input instead, the same
        // direction a chat composer's mention picker opens for the identical
        // reason.
        <ul className="absolute inset-x-2 bottom-full z-10 mb-1 max-h-40 overflow-y-auto rounded border border-line bg-surface shadow-lg">
          <li className="px-2 py-1 text-[10px] font-medium text-ink-faint">Might already exist</li>
          {matches.map((hit) => (
            <li key={hit.entityId}>
              <button
                type="button"
                onClick={() => {
                  setOpenMatch(unsafeAsId<'CardId'>(hit.entityId));
                }}
                className="block w-full truncate px-2 py-1 text-left text-xs text-ink hover:bg-surface-hover"
              >
                {hit.title ?? '(untitled card)'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {openMatch !== null && (
        <CardQuickView
          orgId={orgId}
          cardId={openMatch}
          onClose={() => {
            setOpenMatch(null);
          }}
        />
      )}
    </div>
  );
}
