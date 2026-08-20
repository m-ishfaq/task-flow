import { useOptimistic as useOptimisticCore } from '@taskflow/client';
import { useToast } from './toast-context.js';

export type { OptimisticHandlers, OptimisticSpec } from '@taskflow/client';

/**
 * apps/web's own binding of the shared optimistic-mutation contract
 * (PLAN.md §10.5) to THIS app's toast system.
 *
 * The snapshot/patch/rollback/invalidate logic itself moved to
 * `@taskflow/client` (ai/phase-14-mobile.md §12 decision 4) — it never
 * depended on anything web-specific except how a failure gets SURFACED,
 * which the shared hook now takes as a parameter instead of importing
 * `useToast()` directly. This file is what supplies that parameter, so
 * every existing call site (`useOptimistic()`, no arguments) is unchanged.
 *
 * ```ts
 * const optimistic = useOptimistic();
 * useMutation({ mutationFn, ...optimistic({ keys, patch, failureTitle }) });
 * ```
 */
export function useOptimistic() {
  const toast = useToast();
  return useOptimisticCore((title, error) => {
    toast.failure(title, error);
  });
}
