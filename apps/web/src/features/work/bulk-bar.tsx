import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { describeOutcome, runBulk } from './bulk.js';
import type { Person } from '../org/use-members.js';
import type { Priority, Status } from './api.js';

/**
 * The floating bar shown while cards are selected (`ai/phase-3.5-work-ux.md` §6).
 *
 * Every action here is a LOOP over the same per-card route the single-card UI
 * calls — see bulk.ts for why there is no bulk endpoint. The consequence the
 * bar has to own is that some cards can succeed while others are refused, so
 * nothing here reports "done": it reports what happened, via `describeOutcome`.
 *
 * ## No optimistic patch
 *
 * Unlike every single-card mutation in this app, the bar invalidates and
 * refetches rather than patching the cache. Optimism is a bet that the write
 * will succeed, and it is a good bet for one card the user just edited. Across
 * a selection the bet is wrong by construction — per-card authorization means a
 * partial outcome is the DESIGNED behaviour, and an optimistic patch would show
 * thirty cards changing and then roll eight of them back, which reads as the
 * board glitching rather than as a permission boundary.
 */

export interface BulkBarProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly selected: ReadonlySet<string>;
  readonly statuses: readonly Status[];
  readonly people: readonly Person[];
  readonly onClear: () => void;
}

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export function BulkBar({ orgId, boardId, selected, statuses, people, onClear }: BulkBarProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [running, setRunning] = useState(false);

  if (selected.size === 0) return null;

  const ids = [...selected];

  const run = async (verb: string, apply: (cardId: string) => Promise<unknown>): Promise<void> => {
    setRunning(true);
    try {
      const outcome = await runBulk(ids, apply);

      /* One refetch after the whole run, not one per card. The board query is
         already invalidated as a family, so a per-card invalidation would fire
         the same request thirty times. */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
        queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) }),
      ]);

      toast.show(describeOutcome(outcome, verb), {
        // Neutral even with refusals: the run did what it was allowed to do,
        // and the message already says how much that was.
        tone: outcome.failed.length > 0 ? 'neutral' : 'success',
      });

      // Only clear on a clean run. Leaving the refused cards selected is what
      // lets someone see which ones they were and act on them.
      if (outcome.failed.length === 0) onClear();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit max-w-[95%] flex-wrap items-center gap-2 rounded-card border border-line bg-surface-raised px-3 py-2 shadow-xl"
    >
      <span className="text-xs font-semibold text-ink">{selected.size} selected</span>

      <select
        aria-label="Set status"
        disabled={running}
        value=""
        onChange={(event) => {
          const value = event.target.value;
          if (value === '') return;
          void run('updated', (cardId) =>
            api.work.cards.setStatus.mutate({
              cardId: cardId,
              statusId: value === '__none__' ? null : value,
            }),
          );
        }}
        className="select-premium h-8"
      >
        <option value="">Status…</option>
        <option value="__none__">No status</option>
        {statuses.map((status) => (
          <option key={status.statusId} value={status.statusId}>
            {status.name}
          </option>
        ))}
      </select>

      <select
        aria-label="Set priority"
        disabled={running}
        value=""
        onChange={(event) => {
          const value = event.target.value;
          if (value === '') return;
          void run('updated', async (cardId) => {
            /* Read-then-patch, exactly as `useUpdateCard` does. `cards.update`
               is a full replace whose Zod schema DEFAULTS the fields it is not
               given to null, so sending only a priority would erase a
               description and both dates on every selected card. */
            const card = await api.work.cards.get.query({ cardId: cardId });
            return api.work.cards.update.mutate({
              cardId: cardId,
              version: card.version,
              title: card.title,
              description: card.description as never,
              dueDate: card.dueDate,
              startDate: card.startDate,
              priority: value === '__none__' ? null : (value as Priority),
            });
          });
        }}
        className="select-premium h-8"
      >
        <option value="">Priority…</option>
        <option value="__none__">No priority</option>
        {PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {priority}
          </option>
        ))}
      </select>

      <select
        aria-label="Assign to"
        disabled={running}
        value=""
        onChange={(event) => {
          const value = event.target.value;
          if (value === '') return;
          void run('updated', (cardId) =>
            api.work.cards.assign.mutate({
              cardId: cardId,
              // REPLACES the assignees rather than adding to them. "Assign
              // these to Sam" is what the control says, and a union would make
              // it mean something the label does not.
              assigneeIds: value === '__none__' ? [] : [value],
            }),
          );
        }}
        className="select-premium h-8"
      >
        <option value="">Assign…</option>
        <option value="__none__">Unassign</option>
        {people.map((person) => (
          <option key={person.userId} value={person.userId}>
            {person.label}
          </option>
        ))}
      </select>

      <Button
        size="sm"
        variant="ghost"
        disabled={running}
        onClick={() => {
          void run('archived', (cardId) =>
            api.work.cards.archive.mutate({ cardId: cardId, archived: true }),
          );
        }}
      >
        Archive
      </Button>

      <Button size="sm" variant="ghost" disabled={running} onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
