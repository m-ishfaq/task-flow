import { useState } from 'react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@taskflow/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, MessageSquare, MoreHorizontal, SquareCheck, User } from 'lucide-react';
import type { BoardId, CardId, UserId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useOptimistic } from '../../lib/optimistic.js';
import { Avatar, AvatarStack } from '../../components/primitives.js';
import { formatDueDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useMembers } from '../org/use-members.js';
import { useUpdateCard } from './use-update-card.js';
import { PRIORITY_SWATCH } from './priority-colors.js';
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
  /** Omitted where multi-select does not apply — the drag overlay, and the table view. */
  readonly selected?: boolean;
  readonly onToggleSelect?: (cardId: string, extend: boolean) => void;
}

export function CardTile({
  card,
  orgId,
  onOpen,
  dragging = false,
  selected,
  onToggleSelect,
}: CardTileProps) {
  const due = formatDueDate(card.dueDate);
  const { peopleOf } = useMembers();
  const assignees = peopleOf(card.assigneeIds);

  const body = (
    <>
      {/* The priority signature (`styles.css`'s `--color-priority-urgent`
          comment, `priority-colors.ts`) — absent entirely for an
          unprioritized card, since there is no color for "none" to show.
          Clipped to the tile's rounded corners by `tileClassName`'s
          `overflow-hidden`, not by rounding the bar itself. */}
      {card.priority !== null && (
        <span
          aria-hidden="true"
          className={cn('absolute inset-y-0 left-0 w-[3px]', PRIORITY_SWATCH[card.priority])}
        />
      )}

      {/* Label swatches — a dash per label, color only, no text. The label
          NAME is one popover away (the detail panel's own label section);
          the board only has room to say "this card is tagged," not with
          what. Absent entirely for an unlabeled card, matching the priority
          edge's own "no color for none" rule above. */}
      {card.labelColors.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-[5px]">
          {/* Keyed by color+index rather than a label id the tile was never
              given (the wire only carries colors, not label identity — see
              `labelColorsByCard`) — the list never reorders within a
              render, so this is stable in practice, not merely in theory. */}
          {card.labelColors.map((color, index) => (
            <span
              key={`${color}-${String(index)}`}
              className="h-[5px] w-[26px] rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      )}

      {/* Title — bold, clean, 14px for proper readability on a kanban board */}
      <span className="block text-[14px] font-medium leading-snug text-ink">{card.title}</span>

      {/* The checklist progress meter — a shape a person reads at a glance,
          next to the metadata row's own exact "7/9" fraction rather than in
          place of it: the bar answers "how close," the pill answers "how
          many." Absent for a card with no checklist at all — an empty bar
          would read as 0% progress on a card that was never asked to have
          any. */}
      {card.checklistTotal > 0 && (
        <div
          className="mt-2 h-1 overflow-hidden rounded-sm bg-surface-sunken"
          role="progressbar"
          aria-label="Checklist progress"
          aria-valuenow={card.checklistDone}
          aria-valuemin={0}
          aria-valuemax={card.checklistTotal}
        >
          <div
            className="h-full rounded-sm bg-gradient-to-r from-success to-[oklch(74%_0.13_175)]"
            style={{ width: `${String((card.checklistDone / card.checklistTotal) * 100)}%` }}
          />
        </div>
      )}

      {/* Metadata row — reference, due, checklist, comments, and avatars.
          Generous spacing so the row doesn't feel cramped. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {/* Reference code — styled as a subtle pill for quick scanning */}
        <span className="rounded-md bg-surface-sunken/80 px-2 py-0.5 font-mono text-xs font-medium text-ink-faint">
          {card.reference}
        </span>

        {/* Due date — colored when overdue */}
        {due !== null && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
              due.overdue ? 'bg-danger/15 text-danger' : 'bg-surface-hover text-ink-muted',
            )}
          >
            <Calendar aria-hidden="true" className="size-3" strokeWidth={2} />
            {due.label}
          </span>
        )}

        {/* Checklist progress */}
        {card.checklistTotal > 0 && (
          <span
            title="Checklist progress"
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
              card.checklistDone === card.checklistTotal
                ? 'bg-success/10 text-success'
                : 'bg-surface-hover text-ink-muted',
            )}
          >
            <SquareCheck aria-hidden="true" className="size-3" strokeWidth={2} />
            {card.checklistDone}/{card.checklistTotal}
          </span>
        )}

        {/* Comment count */}
        {card.commentCount > 0 && (
          <span
            title="Comments"
            className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-2 py-0.5 text-xs font-medium text-ink-muted"
          >
            <MessageSquare aria-hidden="true" className="size-3" strokeWidth={2} />
            {card.commentCount}
          </span>
        )}

        {/* Pushed right — faces are what the eye scans a column for */}
        <span className="ml-auto">
          <AvatarStack people={assignees} />
        </span>
      </div>
    </>
  );

  const tileClassName = cn(
    /* Premium card: clean surface, subtle border, generous padding.
       The card sits on surface-raised, one step above the tinted column.
       Border uses 60% opacity for a hairline effect that reads as a
       boundary without noise. */
    'card-tile w-full text-left',
    /* The literal class name `dragging`, not a Tailwind ring utility —
       `styles.css`'s `.card-tile.dragging` rule (the lift-3-weight shadow,
       the accent outline, the slight rotate) was defined and never
       actually reachable: this used to add `ring-1 ring-accent/70`
       instead, a thinner, different-looking treatment that quietly
       replaced it. The drag overlay (`board-view.tsx`'s `DragOverlay`) is
       the one caller that ever passes `dragging`, so this is the only
       place the rule can now fire from. */
    dragging && 'dragging',
    selected === true && 'ring-1 ring-accent',
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
        className={cn(tileClassName, selected === true && 'ring-1 ring-accent')}
        onClick={(event) => {
          /* Ctrl/Cmd- or shift-click SELECTS instead of opening. Two gestures
             on one target, distinguished by modifier, because a card is
             overwhelmingly opened rather than selected — putting selection on
             the plain click would make the common action the awkward one.
             Shift is the range extend; the meta/ctrl pair is the single toggle,
             matching every file manager. */
          if (onToggleSelect !== undefined && (event.shiftKey || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onToggleSelect(card.cardId, event.shiftKey);
            return;
          }
          onOpen(card.cardId);
        }}
      >
        {body}
      </button>

      {/* Shown once anything is selected, not only on hover: the affordance
          that got you into selection mode has to stay visible while you are in
          it, or the only way to see what is picked is to hover each card. */}
      {onToggleSelect !== undefined && (
        <label
          className={cn(
            'absolute top-1.5 left-1.5 transition-opacity duration-(--motion-fast)',
            selected === true
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <span className="sr-only">Select {card.title}</span>
          <input
            type="checkbox"
            checked={selected === true}
            /* `stopPropagation` on pointerdown, not just click: dnd-kit's
               PointerSensor listens on the wrapper this tile sits inside, so
               without it a press on the checkbox begins a drag and the tick
               never registers. */
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onChange={(event) => {
              onToggleSelect(card.cardId, (event.nativeEvent as PointerEvent).shiftKey);
            }}
          />
        </label>
      )}

      {orgId !== undefined && (
        <div
          className={cn(
            'absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-(--motion-fast)',
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
  'flex h-6 w-6 items-center justify-center rounded bg-surface-raised text-ink-muted ' +
  'ring-1 ring-line transition-colors duration-[var(--motion-fast)] ' +
  'hover:text-ink hover:ring-line-strong focus:outline-none focus-visible:ring-accent';

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
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Quick-assign" className={ICON_BUTTON}>
          <User aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
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
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors duration-[var(--motion-fast)]',
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
      </PopoverContent>
    </PopoverRoot>
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
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Quick due date" className={ICON_BUTTON}>
          <Calendar aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-2">
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
          className="h-8 rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink"
        />
      </PopoverContent>
    </PopoverRoot>
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
    mutationFn: () => api.work.cards.archive.mutate({ cardId: card.cardId, archived: true }),
    onSuccess: () => invalidateCard(queryClient, orgId, card.cardId as CardId, boardId),
  });

  return (
    <DropdownMenuRoot
      onOpenChange={(next) => {
        if (!next) setConfirming(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="More actions" className={ICON_BUTTON}>
          <MoreHorizontal aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem
          tone="muted"
          onSelect={(event) => {
            if (!confirming) {
              event.preventDefault();
              setConfirming(true);
              return;
            }
            archive.mutate();
          }}
          className={cn('text-xs', confirming && 'text-danger')}
        >
          {confirming ? 'Confirm archive' : 'Archive'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
