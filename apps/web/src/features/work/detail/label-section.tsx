import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import type { BoardId, CardId, LabelId, ProjectId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { useToast } from '../../../lib/toast-context.js';
import { cn } from '../../../lib/cn.js';
import { Button, Input } from '../../../components/primitives.js';
import { cardLabelsQuery, labelsQuery, patchCardLabels } from '../api.js';

/**
 * Labels on a card, and the project's label set.
 *
 * Two authorization questions live here and are deliberately not merged
 * (apps/api/src/work/label.service.ts):
 *
 *   TAGGING a card is `card:update` — it changes one card.
 *   MANAGING the label set is `project:update` — it changes every card in the
 *   project, so it belongs with the people who own the project's vocabulary.
 *
 * Collapsing them would either stop members tagging their own work or let them
 * rewrite the project's labels from a card panel. The UI shows both controls to
 * everyone and lets the server answer; see the note in projects-page.tsx about
 * not reimplementing `can()` in the browser.
 */

export interface LabelSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly projectId: ProjectId;
}

export function LabelSection({ orgId, boardId, cardId, projectId }: LabelSectionProps) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const toast = useToast();
  const all = useQuery(labelsQuery(orgId, projectId));
  const onCard = useQuery(cardLabelsQuery(orgId, cardId));
  const [creating, setCreating] = useState('');

  const selected = new Set((onCard.data ?? []).map((label) => label.labelId));

  const setLabels = useMutation({
    /* The WHOLE SET, not a delta — matching `setCardLabels` on the server. Two
       people editing labels concurrently with add/remove deltas converge on a
       set neither of them chose; sending the intended set means the last writer
       wins something a human actually asked for. */
    mutationFn: (labelIds: readonly LabelId[]) =>
      api.work.labels.setOnCard.mutate({ cardId, labelIds: [...labelIds] }),

    ...optimistic<readonly LabelId[]>({
      /* The board is in the key list without being patched, and that is the
         point: a board can be FILTERED BY LABEL, so removing one may remove the
         card from the view entirely. That is a decision only the server's filter
         compiler makes, so the board is invalidated and refetched rather than
         guessed at — while the chips themselves, which are what the user is
         looking at, update instantly. */
      keys: [keys.cardLabels(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
      patch: (client, labelIds) => {
        const chosen = new Set<string>(labelIds);
        /* Rebuilt from the PROJECT's label list rather than by adding to and
           removing from the card's own, so the chips keep the project's order.
           Appending the newly-ticked one instead would reorder the row under the
           pointer, and the next click would land on a different label. */
        patchCardLabels(client, orgId, cardId, (current) => {
          const known = all.data ?? current;
          return known.filter((label) => chosen.has(label.labelId));
        });
      },
      failureTitle: 'Labels were not saved',
    }),
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      api.work.labels.create.mutate({ projectId, name, color: nextColor(all.data?.length ?? 0) }),
    /* Not optimistic: the label id comes from the server, and a chip that cannot
       be ticked until the refetch lands is worse than one that appears a moment
       late — the same reason `checklists.addItem` and `cards.create` stay
       round-trip. */
    onSuccess: () => {
      setCreating('');
    },
    onError: (error) => {
      toast.failure('The label was not created', error);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.labels(orgId, projectId) });
    },
  });

  const toggle = (labelId: string) => {
    const next = new Set(selected);
    if (next.has(labelId)) next.delete(labelId);
    else next.add(labelId);
    setLabels.mutate([...next] as LabelId[]);
  };

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-muted uppercase">
        <Tag aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Labels
      </h3>

      {all.data === undefined ? null : all.data.length === 0 ? (
        <p className="text-xs text-ink-faint">This project has no labels yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {all.data.map((label) => {
            const on = selected.has(label.labelId);
            return (
              <li key={label.labelId}>
                <button
                  type="button"
                  aria-pressed={on}
                  /* Not disabled while pending. Tagging a card is usually two or
                     three labels in a row, and a control that goes dead between
                     each one turns one gesture into three waits. Every click
                     sends the full set built from the already-patched cache, so
                     they compose rather than race. */
                  onClick={() => {
                    toggle(label.labelId);
                  }}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px]',
                    on ? 'text-white' : 'bg-surface-hover text-ink-muted hover:text-ink',
                  )}
                  style={on ? { backgroundColor: label.color } : undefined}
                >
                  {label.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const name = creating.trim();
          if (name !== '') create.mutate(name);
        }}
      >
        <Input
          aria-label="New label name"
          placeholder="New label"
          value={creating}
          onChange={(event) => {
            setCreating(event.target.value);
          }}
          className="h-7 text-xs"
        />
        <Button type="submit" size="sm" disabled={create.isPending || creating.trim() === ''}>
          Add
        </Button>
      </form>

      {/* No inline error rows — both mutations report through a toast, which
          outlives the panel being closed by the failure it is reporting. */}
    </section>
  );
}

/**
 * A colour for a new label.
 *
 * Cycled from a fixed palette rather than randomized — `Math.random()` is banned
 * workspace-wide, and reaching for a crypto RNG to pick a swatch would be
 * absurd. Deterministic is also better here: two labels created in a row are
 * visibly different rather than occasionally identical.
 */
const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#6366f1', '#d946ef'];

function nextColor(existing: number): string {
  return PALETTE[existing % PALETTE.length] ?? '#6366f1';
}
