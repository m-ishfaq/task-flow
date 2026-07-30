import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from './toast-context.js';

/**
 * The optimistic mutation contract (PLAN.md §10.5), written once.
 *
 * §10.5 requires every user-visible interaction to be optimistic, with
 * `onMutate` (snapshot + patch), `onError` (rollback + toast) and `onSettled`
 * (invalidate). Three steps, thirteen mutations, and the failure mode is not
 * "someone forgets the whole thing" — it is someone implementing two of the
 * three. Each omission has its own silent symptom:
 *
 *   no snapshot   → a failed drag leaves the card where it was dropped, so the
 *                   board disagrees with the database until a refetch
 *   no toast      → the card snaps back with no explanation, which reads as a
 *                   bug in the drag rather than as a refusal
 *   no invalidate → the optimistic guess becomes the permanent local truth, and
 *                   the server's real answer is never seen
 *   no cancel     → an in-flight GET that left before the patch lands AFTER it
 *                   and silently overwrites it, which looks like the mutation
 *                   never happened
 *
 * So the cycle is a helper rather than a convention. A call site supplies what
 * only it knows — which keys are affected and how the cache changes — and cannot
 * express a version missing a step.
 *
 * ## What this does NOT do
 *
 * It does not touch the server. `mutationFn` stays with the caller, because the
 * request is the part that differs and the reconciliation is the part that does
 * not.
 *
 * It also does not make anything correct that was not. `useUpdateCard`'s
 * read-then-patch design exists because `cards.update` is a full replace and the
 * naive version erases a description per rename; wrapping a mutation in optimism
 * changes when the UI updates, never what is sent.
 */

export interface OptimisticSpec<TVariables> {
  /**
   * The cache entries this mutation affects.
   *
   * Prefixes are fine and are the normal case: `keys.cardsOfBoard(...)` matches
   * every filter variant of a board's cards, and a card moved under one filter
   * has moved under all of them. Snapshot, rollback and invalidation all resolve
   * prefixes to the exact keys present at the time.
   */
  readonly keys: readonly QueryKey[];

  /**
   * Applies the expected outcome to the cache.
   *
   * Called after the snapshot, so it may mutate freely — anything it does is
   * recoverable. It must be synchronous: an await here is a window in which the
   * user sees the old value.
   */
  readonly patch: (client: QueryClient, variables: TVariables) => void;

  /** Toast title when the mutation fails and the patch is rolled back. */
  readonly failureTitle: string;
}

interface Snapshot {
  readonly entries: readonly (readonly [QueryKey, unknown])[];
}

export interface OptimisticHandlers<TVariables> {
  readonly onMutate: (variables: TVariables) => Promise<Snapshot>;
  readonly onError: (error: unknown, variables: TVariables, context: Snapshot | undefined) => void;
  readonly onSettled: () => Promise<void>;
}

/**
 * Builds the three handlers for a `useMutation` call.
 *
 * ```ts
 * const optimistic = useOptimistic();
 * useMutation({ mutationFn, ...optimistic({ keys, patch, failureTitle }) });
 * ```
 */
export function useOptimistic() {
  const client = useQueryClient();
  const toast = useToast();

  return function build<TVariables>(
    spec: OptimisticSpec<TVariables>,
  ): OptimisticHandlers<TVariables> {
    return {
      onMutate: async (variables) => {
        /* Cancelled BEFORE the snapshot is taken. A refetch already in flight
           resolves into the cache whenever it arrives — including after the
           patch — and would overwrite the optimistic value with a pre-mutation
           response. The user sees their change appear and then undo itself for
           no reason, which is indistinguishable from the request having failed
           silently. */
        await Promise.all(spec.keys.map((key) => client.cancelQueries({ queryKey: key })));

        const entries = spec.keys.flatMap((key) => client.getQueriesData({ queryKey: key }));

        spec.patch(client, variables);

        return { entries };
      },

      onError: (error, _variables, context) => {
        for (const [key, data] of context?.entries ?? []) {
          /* `setQueryData(key, undefined)` is a no-op in TanStack — it cannot
             express "there was nothing here". A key that did not exist before
             the patch has to be REMOVED, or an optimistically created entry
             survives its own rollback and renders as real data. */
          if (data === undefined) client.removeQueries({ queryKey: key, exact: true });
          else client.setQueryData(key, data);
        }

        toast.failure(spec.failureTitle, error);
      },

      onSettled: async () => {
        /* On success AND on failure. After a success the patch was a guess —
           `cards.create` invented an id, a move guessed a rank — and the server
           holds the real values. After a failure the rollback restored data that
           may itself now be stale, since the mutation reached the server before
           whatever refused it. */
        await Promise.all(spec.keys.map((key) => client.invalidateQueries({ queryKey: key })));
      },
    };
  };
}
