import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, UserId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useOptimistic } from '../../lib/optimistic.js';
import { Avatar, AvatarStack, Badge } from '../../components/primitives.js';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useMembers } from '../org/use-members.js';
import { useUpdateCard } from './use-update-card.js';
import { invalidateCard, patchBoardCards, type CardSummary } from './api.js';

/**
 * A card as it appears on the board.
 *
 * The counters here — comments, checklist progress — are read straight from the
 * card row, where the API recomputes them inside the writing transaction rather
 * than incrementing them (`counters.ts`). That is what makes it safe to render
 * them as fact: a badge that has drifted looks exactly like one that has not.
 *
 * ## Assignees are faces, not a count
 *
 * `👤 2` said that two people were on a card and refused to say which, so the
 * only way to find out was to open it — on every card, one at a time. That is
 * the question a board is looked at to answer. `useMembers` resolves the ids
 * against the org's member list, which is cached once and shared by every tile,
 * so this costs one query for the whole board rather than one per card.
 *
 * An id that does not resolve falls back to itself rather than disappearing: a
 * member who has left the org is still assigned, and rendering the card as
 * unassigned would misreport it.
 *
 * ## Hover quick actions are siblings, not children, of the open button
 *
 * `ai/phase-3.5-work-ux.md` §4.5: on hover, quick assignee, quick due date and
 * an overflow menu, so the three most common edits do not need a trip through
 * the detail panel. They are laid out as an absolutely-positioned OVERLAY next
 * to the card's own `<button>`, not inside it — nesting a `<button>` inside
 * another is invalid HTML, and the obvious fix (a keydown-handled `<div
 * role="button">` wrapping everything) would need every quick action to
 * `stopPropagation` to keep a click on "Archive" from also opening the card.
 * Siblings need none of that: a click on a quick action never reaches the open
 * button's handler because it is not one of its ancestors, and Radix renders
 * both popovers and the dropdown through a Portal anyway, so their content sits
 * outside this DOM subtree entirely.
 */

export interface CardTileProps {
  readonly card: CardSummary;
  /** Omitted only for the drag overlay ghost, which opens nothing and edits nothing. */
  readonly orgId?: string;
  readonly onOpen?: (cardId: string) => void;
  readonly dragging?: boolean;
}

export function CardTile({ card, orgId, onOpen, dragging = false }: CardTileProps) {
  const due = formatDueDate(card.dueDate);
  const { peopleOf } = useMembers();
  const assignees = peopleOf(card.assigneeIds);

  const body = (
    <>
      <span className="block text-sm leading-snug text-ink">{card.title}</span>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-ink-faint">{card.reference}</span>

        {due !== null && (
          <Badge className={cn(due.overdue && 'bg-danger/20 text-danger')}>{due.label}</Badge>
        )}

        {card.checklistTotal > 0 && (
          <Badge
            title="Checklist progress"
            className={cn(card.checklistDone === card.checklistTotal && 'text-success')}
          >
            ☑ {card.checklistDone}/{card.checklistTotal}
          </Badge>
        )}

        {card.commentCount > 0 && <Badge title="Comments">💬 {card.commentCount}</Badge>}

        {/* Pushed right and kept on the metadata row rather than wrapping with
            it. Faces are what the eye scans a column for, so they need a fixed
            position — badges reflowing them to a different x per card is what
            makes a board tiring to read. */}
        <span className="ml-auto">
          <AvatarStack people={assignees} />
        </span>
      </div>
    </>
  );

  const tileClassName = cn(
    'w-full rounded-card border border-line bg-surface-raised px-2.5 py-2 text-left transition-colors',
    dragging ? 'shadow-lg ring-1 ring-accent' : 'hover:border-line-strong hover:bg-surface-hover',
  );

  /* The drag overlay is not interactive — it is a picture following the pointer
     — so it renders as a div. A button there would be focusable and announced,
     duplicating the real card for anyone using a screen reader. */
  if (onOpen === undefined) {
    return <div className={tileClassName}>{body}</div>;
  }

  return (
    <div className="group relative">
      <button
        type="button"
        className={tileClassName}
        onClick={() => {
          onOpen(card.cardId);
        }}
      >
        {body}
      </button>

      {orgId !== undefined && (
        <div
          className={cn(
            'absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <QuickAssignee orgId={orgId} card={card} />
          <QuickDueDate orgId={orgId} boardId={card.boardId as BoardId} card={card} />
          <QuickOverflow orgId={orgId} boardId={card.boardId as BoardId} card={card} />
        </div>
      )}
    </div>
  );
}

const ICON_BUTTON =
  'flex h-6 w-6 items-center justify-center rounded bg-surface-raised text-xs text-ink-muted ' +
  'ring-1 ring-line hover:text-ink hover:ring-line-strong focus:outline-none focus-visible:ring-accent';

/**
 * Quick-assign, straight from the tile.
 *
 * Same optimistic pattern as `AssigneeSection` — send the whole set, patch the
 * board cache before the server answers — narrowed to `cardsOfBoard` alone.
 * There is no open detail panel here for a `keys.card` entry to patch.
 */
function QuickAssignee({ orgId, card }: { readonly orgId: string; readonly card: CardSummary }) {
  const { people } = useMembers();
  const optimistic = useOptimistic();

  const assign = useMutation({
    mutationFn: (ids: readonly string[]) =>
      api.work.cards.assign.mutate({
        cardId: card.cardId,
        assigneeIds: ids as UserId[],
      }),

    ...optimistic<readonly string[]>({
      keys: [keys.cardsOfBoard(orgId, card.boardId)],
      patch: (client, ids) => {
        patchBoardCards(client, orgId, card.boardId as BoardId, (cards) =>
          cards.map((entry) =>
            entry.cardId === card.cardId ? { ...entry, assigneeIds: [...ids] } : entry,
          ),
        );
      },
      failureTitle: 'Assignees were not saved',
    }),
  });

  const selected = new Set(card.assigneeIds);
  const toggle = (userId: string) => {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    assign.mutate([...next]);
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Quick-assign" className={ICON_BUTTON}>
          👤
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="w-56 rounded border border-line bg-surface-raised p-2 shadow-xl"
        >
          {people.length === 0 ? (
            <p className="p-1 text-xs text-ink-faint">No members to assign.</p>
          ) : (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto">
              {people.map((member) => {
                const on = selected.has(member.userId);
                return (
                  <li key={member.userId}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        toggle(member.userId);
                      }}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs',
                        on
                          ? 'bg-accent text-accent-ink'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                      )}
                    >
                      <Avatar userId={member.userId} label={member.email} size="xs" />
                      <span className="truncate">{member.email}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Quick due date, straight from the tile.
 *
 * Goes through `useUpdateCard` rather than a bespoke call, for the reason
 * documented there: `cards.update` is a full replace, and a caller holding only
 * a `CardSummary` — which is exactly what a tile has — cannot safely send one
 * directly without erasing the description and start date this row was never
 * given. The board tile updates optimistically because `useUpdateCard` now
 * patches `cardsOfBoard`; see that file for the one place this still waits on
 * the round trip.
 */
function QuickDueDate({
  orgId,
  boardId,
  card,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly card: CardSummary;
}) {
  const update = useUpdateCard(orgId, boardId);
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Quick due date" className={ICON_BUTTON}>
          📅
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="rounded border border-line bg-surface-raised p-2 shadow-xl"
        >
          <input
            type="date"
            aria-label="Due date"
            defaultValue={card.dueDate?.slice(0, 10) ?? ''}
            onChange={(event) => {
              const day = event.target.value;
              update.mutate({
                cardId: card.cardId as CardId,
                patch: { dueDate: day === '' ? null : new Date(`${day}T00:00:00`).toISOString() },
              });
              setOpen(false);
            }}
            className="h-8 rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The overflow menu.
 *
 * Archive only, for now — it is the one tile-level action that already exists
 * elsewhere (`ArchiveCardButton` in the detail panel) and needs no new server
 * surface. It keeps the SAME two-step confirmation, compacted into one menu
 * item that swaps its own label: a card archived from a hover menu with no
 * undo in this build is exactly the accidental-click case the detail panel's
 * confirm/cancel pair exists to prevent, and a quick action is not an excuse to
 * drop it. `onSelect` calls `preventDefault` on the first click specifically to
 * stop Radix closing the menu before the second, confirming click can land.
 */
function QuickOverflow({
  orgId,
  boardId,
  card,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly card: CardSummary;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const archive = useMutation({
    mutationFn: () =>
      api.work.cards.archive.mutate({ cardId: card.cardId, archived: true }),
    onSuccess: () => invalidateCard(queryClient, orgId, card.cardId as CardId, boardId),
  });

  return (
    <DropdownMenu.Root
      onOpenChange={(next) => {
        if (!next) setConfirming(false);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="More actions" className={ICON_BUTTON}>
          ⋯
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="min-w-36 rounded border border-line bg-surface-raised p-1 shadow-xl"
        >
          <DropdownMenu.Item
            onSelect={(event) => {
              if (!confirming) {
                event.preventDefault();
                setConfirming(true);
                return;
              }
              archive.mutate();
            }}
            className={cn(
              'cursor-pointer rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-surface-hover',
              confirming ? 'text-danger' : 'text-ink-muted',
            )}
          >
            {confirming ? 'Confirm archive' : 'Archive'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
