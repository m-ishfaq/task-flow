import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CardId } from '@taskflow/contracts';
import { useOptimistic, wire } from '@taskflow/client';
import { apiClient } from './app-session.js';
import { mergePatch, type CardPatch } from './card-patch.js';
import { cardQueryKey, MY_TASKS_QUERY_KEY, type CardDetail } from './work.js';

export type { CardPatch, RichText } from './card-patch.js';

/**
 * Editing a card — Wave 2's "optimistic mutations" roadmap item
 * (`ai/phase-14-mobile.md`), ported from `apps/web/src/features/work/
 * use-update-card.ts`. The read-then-merge logic that makes `cards.update`'s
 * full-replace shape safe to call from a partial edit lives in
 * `card-patch.ts` (`mergePatch`) — see that file's own header for why it is
 * split out, and read it before this one: it is the part actually worth
 * understanding.
 *
 * ## What is simpler here than on web, and why
 *
 * Web also patches `cardsOfBoard` optimistically, because a board's tiles
 * are visible WHILE the detail panel is open — the same card exists in two
 * places on screen at once. Mobile has no board view yet (`(tabs)/home.tsx`
 * is a flat list, not a board), so there is no second visible copy of a
 * card to patch simultaneously; `card/[cardId].tsx` IS the only place a card
 * renders while being edited. So this patches only the detail query itself
 * — the screen the user is actually looking at — and invalidates both that
 * query and `work.cards.mine` on settle, so a title/priority change is
 * already there the moment the user navigates back to "My Tasks" rather
 * than waiting on that list's own staleness window.
 *
 * `useOptimistic` is `@taskflow/client`'s shared contract (PLAN.md §10.5),
 * not a copy: the same snapshot/patch/rollback/invalidate cycle apps/web's
 * hook already builds on, extracted specifically so this file did not have
 * to reimplement it — see that package's own header for why `onFailure` is
 * a parameter rather than an import (apps/mobile has no toast system, and
 * would not share apps/web's even if it did).
 */
async function applyPatch(
  client: QueryClient,
  cardId: CardId,
  patch: CardPatch,
): Promise<{ readonly version: number }> {
  const current: CardDetail = await client.ensureQueryData({
    queryKey: cardQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.cards.get.query({ cardId })),
  });

  return apiClient.work.cards.update.mutate({
    cardId,
    version: current.version,
    ...mergePatch(current, patch),
  });
}

export function useUpdateCard(cardId: CardId, onFailure: (title: string, error: unknown) => void) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic(onFailure);

  return useMutation({
    mutationFn: (patch: CardPatch) => applyPatch(queryClient, cardId, patch),

    ...optimistic<CardPatch>({
      keys: [cardQueryKey(cardId)],
      patch: (client, patch) => {
        client.setQueryData(cardQueryKey(cardId), (existing: CardDetail | undefined) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...('priority' in patch ? { priority: patch.priority ?? null } : {}),
                ...('dueDate' in patch ? { dueDate: patch.dueDate ?? null } : {}),
                ...('startDate' in patch ? { startDate: patch.startDate ?? null } : {}),
                ...('description' in patch ? { description: patch.description ?? null } : {}),
              },
        );
      },
      failureTitle: 'The card was not saved',
    }),

    // Overrides `optimistic(...)`'s own `onSettled` (an object spread does
    // not compose two handlers of the same name — the later one wins),
    // mirroring web's identical override in its own `useUpdateCard` for the
    // identical reason: that generic `onSettled` only knows about `keys`
    // above (`cardQueryKey(cardId)`), and this hook also needs
    // `MY_TASKS_QUERY_KEY` invalidated — the list has no optimistic patch
    // of its own (see this file's own header), so invalidating it here is
    // the only thing that ever refreshes it. Both are invalidated on
    // success AND failure: a success's patch was a guess at the fields it
    // touched (the server also holds `version`, which the patch above never
    // updates, and `updatedAt`), and a failure's rollback may itself now be
    // stale.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      ]);
    },
  });
}
