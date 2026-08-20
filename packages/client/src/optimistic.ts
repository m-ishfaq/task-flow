import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * The optimistic mutation contract (PLAN.md §10.5), written once — shared
 * rather than kept in `apps/web` alone (ai/phase-14-mobile.md §5, §12
 * decision 4). §10.5 requires every user-visible interaction to be
 * optimistic, with `onMutate` (snapshot + patch), `onError` (rollback +
 * surface the failure) and `onSettled` (invalidate). Three steps, and the
 * failure mode is not "someone forgets the whole thing" — it is someone
 * implementing two of the three. Each omission has its own silent symptom:
 *
 *   no snapshot   → a failed drag leaves the card where it was dropped, so
 *                   the board disagrees with the database until a refetch
 *   no surfacing  → the card snaps back with no explanation, which reads as
 *                   a bug in the drag rather than as a refusal
 *   no invalidate → the optimistic guess becomes the permanent local truth,
 *                   and the server's real answer is never seen
 *   no cancel     → an in-flight GET that left before the patch lands AFTER
 *                   it and silently overwrites it, which looks like the
 *                   mutation never happened
 *
 * So the cycle is a helper rather than a convention. A call site supplies
 * what only it knows — which keys are affected and how the cache changes —
 * and cannot express a version missing a step.
 *
 * ## What this does NOT do
 *
 * It does not touch the server. `mutationFn` stays with the caller, because
 * the request is the part that differs and the reconciliation is the part
 * that does not.
 *
 * It also does not make anything correct that was not. `apps/web`'s
 * `useUpdateCard`'s read-then-patch design exists because `cards.update` is
 * a full replace and the naive version erases a description per rename;
 * wrapping a mutation in optimism changes when the UI updates, never what is
 * sent.
 *
 * ## Why `onFailure` is a parameter, not an import
 *
 * The original `apps/web`-only version called `useToast()` directly inside
 * this hook. That is exactly the kind of app-specific UI dependency this
 * package cannot carry — `apps/mobile` has no toast system yet, and even
 * once it does, it will not be `apps/web`'s `toast-context.js`. Taking the
 * failure surface as a parameter keeps every step of the actual
 * snapshot/patch/rollback/invalidate contract shared while leaving HOW a
 * failure reaches the user entirely to the caller.
 */

export interface OptimisticSpec<TVariables> {
  /**
   * The cache entries this mutation affects.
   *
   * Prefixes are fine and are the normal case: a board's "every card" key
   * matches every filter variant, and a card moved under one filter has
   * moved under all of them. Snapshot, rollback and invalidation all
   * resolve prefixes to the exact keys present at the time.
   */
  readonly keys: readonly QueryKey[];

  /**
   * Applies the expected outcome to the cache.
   *
   * Called after the snapshot, so it may mutate freely — anything it does
   * is recoverable. It must be synchronous: an await here is a window in
   * which the user sees the old value.
   */
  readonly patch: (client: QueryClient, variables: TVariables) => void;

  /** Passed to `onFailure` when the mutation fails and the patch is rolled back. */
  readonly failureTitle: string;
}

interface Snapshot {
  readonly entries: readonly (readonly [QueryKey, unknown])[];
  /** The stringified exact keys that had a query object before the patch. */
  readonly existingKeys: ReadonlySet<string>;
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
 * const optimistic = useOptimistic((title, error) => toast.failure(title, error));
 * useMutation({ mutationFn, ...optimistic({ keys, patch, failureTitle }) });
 * ```
 */
export function useOptimistic(onFailure: (title: string, error: unknown) => void) {
  const client = useQueryClient();

  return function build<TVariables>(
    spec: OptimisticSpec<TVariables>,
  ): OptimisticHandlers<TVariables> {
    return {
      onMutate: async (variables) => {
        /* Cancelled BEFORE the snapshot is taken. A refetch already in
           flight resolves into the cache whenever it arrives — including
           after the patch — and would overwrite the optimistic value with a
           pre-mutation response. The user sees their change appear and then
           undo itself for no reason, which is indistinguishable from the
           request having failed silently. */
        await Promise.all(spec.keys.map((key) => client.cancelQueries({ queryKey: key })));

        const entries = spec.keys.flatMap((key) => client.getQueriesData({ queryKey: key }));

        /* WHICH exact keys had a query object at all, snapshotted separately
           from their data — see onError's own comment for why data alone
           (specifically `data === undefined`) cannot answer this. */
        const existingKeys = new Set(entries.map(([key]) => JSON.stringify(key)));

        spec.patch(client, variables);

        return { entries, existingKeys };
      },

      onError: (error, _variables, context) => {
        for (const [key, data] of context?.entries ?? []) {
          client.setQueryData(key, data);
        }

        /* A query the patch created has no snapshot counterpart at all —
           `context.entries` never contained it, so the loop above never
           touches it — and it must be REMOVED, not merely left with
           whatever the patch wrote, or an optimistically created entry
           survives its own rollback and renders as real data.
           `data === undefined` looks like it would catch this and does
           not: `getQueriesData` only returns entries for query objects
           that ALREADY EXIST in the cache, so a genuinely new key never
           appears in `context.entries` in the first place — proven by
           `optimistic.test.tsx`'s own regression case, which failed
           against the data-based check before this one replaced it.
           Checking KEY PRESENCE via `findAll` after the patch, against the
           snapshot's `existingKeys`, is what actually distinguishes "was
           here before, happened to have no data yet" (restored above, left
           alone here) from "did not exist before the patch at all"
           (removed here). */
        for (const key of spec.keys) {
          for (const query of client.getQueryCache().findAll({ queryKey: key })) {
            if (!context?.existingKeys.has(JSON.stringify(query.queryKey))) {
              client.removeQueries({ queryKey: query.queryKey, exact: true });
            }
          }
        }

        onFailure(spec.failureTitle, error);
      },

      onSettled: async () => {
        /* On success AND on failure. After a success the patch was a
           guess — a create invented an id, a move guessed a rank — and the
           server holds the real values. After a failure the rollback
           restored data that may itself now be stale, since the mutation
           reached the server before whatever refused it. */
        await Promise.all(spec.keys.map((key) => client.invalidateQueries({ queryKey: key })));
      },
    };
  };
}
