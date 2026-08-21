import { format, isPast, isToday, isTomorrow } from 'date-fns';
import { parseNullableInstant, type Wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Work (§Wave 2, ai/phase-14-mobile.md) — "My Tasks", the first product
 * surface on native. Ported from `apps/web/src/lib/format.ts`'s
 * `formatDueDate` and `apps/web/src/features/work/priority-colors.ts`,
 * which this file is deliberately kept in step with rather than
 * reimplementing independently — a due-date badge that reads "overdue" on
 * web and "on time" on native for the identical card is exactly the kind of
 * drift guardrail 5 exists to rule out, even though `date-fns` and
 * `@taskflow/tokens` are two more indirections than a copy-paste would need.
 *
 * `Priority` has no shared contracts package to import from (Work's Zod
 * schemas live in `apps/api/src/work/router.ts`, server-only) — restated
 * here as the same four-value literal union apps/web's own `api.ts` does,
 * which is exactly what `Wire<T>` is for: the wire shape is the contract,
 * not the server module.
 */
export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

/** Mirrors `PRIORITY_SWATCH` — the same four tokens, as native color values instead of Tailwind classes. */
export const PRIORITY_COLOR: Readonly<Record<Priority, string>> = {
  urgent: colors.priorityUrgent.hex,
  high: colors.warning.hex,
  normal: colors.priorityMedium.hex,
  low: colors.inkFaint.hex,
};

export interface DueDateDisplay {
  readonly label: string;
  readonly overdue: boolean;
}

/** `apps/web/src/lib/format.ts`'s `formatDueDate`, verbatim logic. */
export function formatDueDate(value: string | null): DueDateDisplay | null {
  const due = parseNullableInstant(value);
  if (due === null) return null;

  const label = isToday(due) ? 'Today' : isTomorrow(due) ? 'Tomorrow' : format(due, 'd MMM');
  return { label, overdue: isPast(due) && !isToday(due) };
}

/**
 * Derived from the live client's own inferred type, the same
 * `Awaited<ReturnType<typeof api.<route>.query>>` convention
 * `apps/web/src/features/work/api.ts`'s `CardSummary` uses — never
 * hand-declared, so a field this codebase adds, removes, or renames on the
 * server is a compile error here rather than a silent drift between what
 * the type claims and what `work.cards.mine` actually answers. `Wire<T>`
 * restates the `Date | null` fields (`dueDate`) as the JSON strings that
 * actually cross the wire — see `@taskflow/client`'s own header for why
 * that correction has to be explicit rather than assumed.
 *
 * `MobileTRPCClient` is imported as a TYPE only — this file stays
 * Expo-free and Vitest-safe (`work.test.ts` has no native runtime in its
 * module graph) because a `import type` is erased entirely before either
 * ever tries to load the real module behind it.
 */
export type CardSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['cards']['mine']['query']>>
>[number];

/** The same derivation as `CardSummary`, off `work.cards.get` instead of `.mine` — see that type's own header. */
export type CardDetail = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['cards']['get']['query']>>
>;

/**
 * The `work.cards.mine` query key, shared between `home.tsx` (which reads
 * it) and `use-update-card.ts` (which invalidates it after an edit) — a
 * literal repeated at both call sites is exactly the kind of drift that
 * makes an invalidation silently stop matching the query it was meant to
 * refresh the day one side's array literal changes and the other does not.
 */
export const MY_TASKS_QUERY_KEY = ['work.cards.mine'] as const;

/** The `work.cards.get` query key for one card — see `MY_TASKS_QUERY_KEY`'s own comment for why this is a function, not a literal, at each call site. */
export function cardQueryKey(cardId: string): readonly ['work.cards.get', string] {
  return ['work.cards.get', cardId];
}
