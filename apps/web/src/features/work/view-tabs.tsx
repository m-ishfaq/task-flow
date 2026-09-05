import { useState } from 'react';
import { ModalClose, ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { FilterTree } from '@taskflow/filter';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { viewsQuery, type SavedView } from './api.js';
import { matchingView, type BoardArrangement } from './view-match.js';

/**
 * Saved views as tabs on the board toolbar (`ai/phase-3.5-work-ux.md` §6).
 *
 * ## What a view is, and what it is not
 *
 * A view is the four things the toolbar already controls — renderer, grouping,
 * sort and filter — given a name. The URL remains the source of truth for what
 * is currently on screen: selecting a view WRITES those four params and nothing
 * else. That ordering matters. If a selected view were its own state, the board
 * would have two descriptions of itself, and a link someone pasted into chat
 * would carry one of them while the tab strip showed the other.
 *
 * So there is no "currently selected view" stored anywhere. `matchingView`
 * derives the active tab by comparing the URL against each saved view, which
 * means editing a filter simply stops matching and the tab quietly deselects —
 * the honest outcome, because at that point you are no longer looking at the
 * saved thing.
 *
 * ## Shared versus private
 *
 * A PRIVATE view needs only `board:read` to save or delete (author-only,
 * enforced by identity, not a permission). Publishing or deleting a SHARED
 * one is `board:update`. `canManageBoard` (`boards.list`'s per-board
 * `capabilities.update`) gates the "Share with everyone" checkbox and a
 * shared view's own delete button — this used to render both
 * unconditionally and let a Member's click come back FORBIDDEN (Phase 15
 * §1's sweep; this file's own comment used to cite the permission debug
 * page as the precedent for NOT gating, which is now the opposite of that
 * page's own fix).
 */

export interface ViewTabsProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  /** What the URL currently says the board is showing. */
  readonly current: BoardArrangement;
  readonly onApply: (arrangement: BoardArrangement) => void;
  readonly canManageBoard: boolean;
}

export function ViewTabs({ orgId, boardId, current, onApply, canManageBoard }: ViewTabsProps) {
  const views = useQuery(viewsQuery(orgId, boardId));
  const [saving, setSaving] = useState(false);

  const saved = views.data ?? [];
  const activeId = matchingView(saved, current);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {saved.map((view) => (
        <ViewTab
          key={view.viewId}
          orgId={orgId}
          boardId={boardId}
          view={view}
          active={view.viewId === activeId}
          onApply={onApply}
          canManageBoard={canManageBoard}
        />
      ))}

      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setSaving(true);
        }}
      >
        Save view
      </Button>

      {saving && (
        <SaveViewDialog
          orgId={orgId}
          boardId={boardId}
          current={current}
          canManageBoard={canManageBoard}
          onClose={() => {
            setSaving(false);
          }}
        />
      )}
    </div>
  );
}

function ViewTab({
  orgId,
  boardId,
  view,
  active,
  onApply,
  canManageBoard,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly view: SavedView;
  readonly active: boolean;
  readonly onApply: (arrangement: BoardArrangement) => void;
  readonly canManageBoard: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const remove = useMutation({
    mutationFn: () => api.work.views.delete.mutate({ viewId: view.viewId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.views(orgId, boardId) });
    },
    onError: (error) => {
      toast.failure('The view could not be deleted', error);
    },
  });

  return (
    <span
      className={cn(
        'group flex items-center rounded border px-0.5',
        active ? 'border-accent bg-accent/10' : 'border-transparent',
      )}
    >
      <button
        type="button"
        /* A broken filter is disabled rather than hidden. Hiding it would make
           a view the author saved appear to have vanished; saying so lets them
           delete it or fix it. */
        disabled={view.filterBroken}
        title={
          view.filterBroken
            ? 'This view’s filter is no longer valid — delete it and save a new one.'
            : undefined
        }
        onClick={() => {
          /* Stored nulls become the toolbar's defaults — a view saved before a
             field existed is the default arrangement, not an absent one.

             The filter is PARSED, not cast. `views.list` returns it as
             `unknown` on purpose so one unreadable row cannot 500 the whole
             tab strip, which means the type here is honest about not knowing —
             and the fix for that is a parser, not an assertion that silences
             it. Same schema the URL is parsed with, since that is where this
             value is about to end up. */
          const parsed = FilterTree.safeParse(view.filter);
          onApply({
            type: view.type,
            groupBy: view.groupBy ?? 'list',
            sortBy: view.sortBy ?? 'manual',
            filter: parsed.success ? parsed.data : null,
          });
        }}
        className="max-w-40 truncate px-2 py-1 text-xs text-ink disabled:text-ink-faint disabled:line-through"
      >
        {view.name}
        {!view.isShared && (
          // Private views sit alongside shared ones in the same strip, so the
          // strip has to say which is which — otherwise someone "shares" a
          // board arrangement nobody else can see.
          <span className="ml-1 text-[10px] text-ink-faint">private</span>
        )}
      </button>

      {/* A private view is author-only (identity, not a permission — the
          server never returns another person's private view, so every one
          here IS the caller's own). A shared view's delete is `board:update`,
          same as the "Share" checkbox below. */}
      {(!view.isShared || canManageBoard) && (
        <button
          type="button"
          aria-label={`Delete ${view.name}`}
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
          className="px-1 text-xs text-ink-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
}

function SaveViewDialog({
  orgId,
  boardId,
  current,
  canManageBoard,
  onClose,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly current: BoardArrangement;
  readonly canManageBoard: boolean;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [isShared, setIsShared] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.work.views.create.mutate({
        boardId,
        name,
        /* Insights are ephemeral and not persistable — the API only accepts
             board/table/list. Sending 'insights' would fail validation, so
             fall back to 'board' for saved views. */
        type: current.type === 'insights' ? 'board' : current.type,
        groupBy: current.groupBy,
        sortBy: current.sortBy,
        filter: current.filter,
        visibleColumns: null,
        isShared,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.views(orgId, boardId) });
      onClose();
    },
  });

  return (
    <ModalRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalContent size="sm" className="p-4">
        <ModalTitle>Save this view</ModalTitle>
        <ModalDescription>
          Saves the current layout, grouping, sort and filter under a name.
        </ModalDescription>

        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="block space-y-1">
            <span className="text-[11px] text-ink-faint">Name</span>
            {/* No `autoFocus`: it is a lint error here for a11y reasons, and
                  Radix already moves focus into the dialog on open — which
                  announces the dialog first rather than dropping a screen
                  reader user into an unlabelled field. */}
            <input
              value={name}
              maxLength={60}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
            />
          </label>

          {canManageBoard && (
            <label className="flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={isShared}
                onChange={(event) => {
                  setIsShared(event.target.checked);
                }}
              />
              Share with everyone on this board
            </label>
          )}

          {save.isError && <ErrorText error={save.error} />}

          <div className="flex justify-end gap-2">
            <ModalClose asChild>
              <Button size="sm" variant="ghost" type="button">
                Cancel
              </Button>
            </ModalClose>
            <Button size="sm" type="submit" disabled={name.trim() === '' || save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </ModalContent>
    </ModalRoot>
  );
}
