import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardId, CardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { cardQuery, invalidateCard, type CardDetail } from './api.js';

/**
 * Editing a card without silently destroying the fields you did not touch.
 *
 * ## The trap
 *
 * `work.cards.update` is a FULL REPLACE. Its input requires `title`,
 * `description`, `dueDate` and `startDate`, and the service writes all four —
 * `description: null` sets the description to null, it does not mean "leave it
 * alone" (apps/api/src/work/card.service.ts). The Zod schema even defaults the
 * three optional-looking ones to `null`, so OMITTING a field is the same as
 * clearing it.
 *
 * That is a reasonable API and a loaded gun for a caller holding a card SUMMARY.
 * `cards.list` returns no `description` and no `startDate`, so the obvious
 * inline-edit implementation — take the row from the table, change the title,
 * send it — erases every description on the board one rename at a time. Nothing
 * fails. The card looks right; the panel that would have shown the loss is
 * closed.
 *
 * ## What this does instead
 *
 * Reads the FULL card first, applies the patch to that, and sends the result. So
 * a caller can only express "change these fields", and there is no way to
 * express "clear the ones I could not see". `ensureQueryData` means the read is
 * usually free — the detail panel has already fetched it.
 *
 * `version` comes from the same read rather than from the caller, which is what
 * keeps the optimistic-concurrency check honest: the version travelling with the
 * write is the version of the values being written, not one a stale row happened
 * to carry.
 */

/**
 * A rich text document, as the API's `RichTextDocument` schema parses it.
 *
 * Structural rather than imported: the API's `RichTextNode` is the shape the
 * SERVICES work with, and importing it here would tie the browser bundle's types
 * to a module whose job is validation. The server re-parses whatever arrives, so
 * this only has to be honest about what is being sent.
 */
export interface RichText {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: unknown;
  readonly marks?: readonly unknown[] | undefined;
  readonly content?: readonly RichText[] | undefined;
}

export interface CardPatch {
  readonly title?: string;
  readonly description?: RichText | null;
  readonly dueDate?: string | null;
  readonly startDate?: string | null;
}

async function applyPatch(
  client: QueryClient,
  orgId: string,
  cardId: CardId,
  patch: CardPatch,
): Promise<{ readonly version: number }> {
  const current: CardDetail = await client.ensureQueryData(cardQuery(orgId, cardId));

  return api.work.cards.update.mutate({
    cardId,
    version: current.version,
    title: patch.title ?? current.title,
    /* `in` rather than `!== undefined`: clearing a description is expressed as
       `{ description: null }`, and `??` would treat that as "not supplied" and
       restore the old value — an edit that silently does nothing. */
    description:
      'description' in patch ? (patch.description ?? null) : asRichText(current.description),
    dueDate: 'dueDate' in patch ? (patch.dueDate ?? null) : current.dueDate,
    startDate: 'startDate' in patch ? (patch.startDate ?? null) : current.startDate,
  });
}

/**
 * Narrows the stored description so it can be written straight back.
 *
 * `cards.get` returns it as `unknown` — its shape is decided by
 * `RichTextDocument` on the server, not by the route's output schema — and a
 * value that is not a document must become `null` rather than be forwarded.
 * Forwarding it would fail validation on a WRITE the user did not make, so
 * renaming a card whose description was somehow malformed would be impossible
 * until the description was fixed.
 */
function asRichText(value: unknown): RichText | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as { type?: unknown }).type === 'string' ? (value as RichText) : null;
}

export function useUpdateCard(orgId: string, boardId: BoardId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ cardId, patch }: { cardId: CardId; patch: CardPatch }) =>
      applyPatch(queryClient, orgId, cardId, patch),

    onSettled: async (_result, _error, variables) => {
      /* Not retried and not optimistic. A CONFLICT here means someone else saved
         first, and the correct response is to show them the current card — which
         invalidation does — rather than to re-send the same version and lose the
         other edit on the second attempt. */
      await invalidateCard(queryClient, orgId, variables.cardId, boardId);
    },
  });
}
