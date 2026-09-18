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

/**
 * Boards (Wave 2's remaining roadmap item, after "My Tasks" and card
 * detail): projects, boards and lists, derived off the live client the same
 * way `CardSummary`/`CardDetail` are — never hand-declared.
 */
export type Project = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['projects']['list']['query']>>
>[number];

export type Board = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['boards']['list']['query']>>
>[number];

export type ListSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['lists']['list']['query']>>
>[number];

export const PROJECTS_QUERY_KEY = ['work.projects.list'] as const;

export function boardsQueryKey(projectId: string): readonly ['work.boards.list', string] {
  return ['work.boards.list', projectId];
}

export function listsQueryKey(boardId: string): readonly ['work.lists.list', string] {
  return ['work.lists.list', boardId];
}

/**
 * Archived columns — nested UNDER `listsQueryKey`'s own key, mirroring
 * `apps/web/src/features/work/api.ts`'s `archivedListsQuery`, so archiving
 * or restoring a column (which already invalidates that family) refreshes
 * this list too with no second invalidation to remember.
 */
export function archivedListsQueryKey(
  boardId: string,
): readonly ['work.lists.list', string, 'archived'] {
  return ['work.lists.list', boardId, 'archived'];
}

/**
 * The board's own card read — `work.cards.list({ boardId })` — shares
 * `CardSummaryOutput` with `work.cards.mine` server-side (identical fields,
 * including `listId`, which is what lets a board group these by column), so
 * this reuses `CardSummary` rather than declaring a second, structurally
 * identical type.
 */
export function boardCardsQueryKey(boardId: string): readonly ['work.cards.list', string] {
  return ['work.cards.list', boardId];
}

/**
 * Archived cards — nested UNDER `boardCardsQueryKey`'s own key, the
 * identical convention `archivedListsQueryKey` uses just above, and for the
 * same reason: `work.cards.list`'s `includeArchived` WIDENS past the
 * hardcoded live-only filter rather than narrowing to archived-only
 * (`apps/api/src/work/router.ts`'s own comment on `cards.list`), so the
 * caller filters for `archivedAt !== null` client-side — mirroring web's
 * `archivedCardsQuery` exactly.
 */
export function archivedCardsQueryKey(
  boardId: string,
): readonly ['work.cards.list', string, 'archived'] {
  return ['work.cards.list', boardId, 'archived'];
}

/**
 * The board's card read, filter-aware — nested UNDER `boardCardsQueryKey`'s
 * own key, the same convention `archivedCardsQueryKey` uses, so every
 * mutation that already invalidates the unfiltered key (create, move,
 * archive, bulk actions) refreshes whatever filtered view is on screen too,
 * with no second invalidation to remember. `filterKey` is a caller-computed
 * fragment (`board-filter.ts`'s own `boardFilterKey`, mirroring web's
 * `filterKey` in `apps/web/src/features/work/api.ts`) rather than the raw
 * `FilterNode` itself, so two structurally-equal filters built at different
 * times share one cache entry instead of comparing objects by reference.
 */
export function filteredBoardCardsQueryKey(
  boardId: string,
  filterKey: string,
): readonly ['work.cards.list', string, string] {
  return ['work.cards.list', boardId, filterKey];
}

/**
 * Due-date grouping for "My Tasks" — ported from
 * `apps/web/src/features/work/grouping.ts`'s `dueBucketOf`/`groupCards`,
 * narrowed to just the `'due'` case rather than the full five-way
 * `GroupBy` union: My Tasks is the ONLY screen on either platform that
 * groups by due date (a board's own group-by control is real, separate
 * work — `board/[boardId].tsx`'s own header on why boards are a tab strip
 * here, not columns), so the other four groupings would be dead code on
 * native today. `home.tsx`'s own header already argues status has no
 * cross-project vocabulary to group by; assignee and priority groupings
 * are equally board-scoped concerns this file has no reason to carry yet.
 */
export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

const DUE_BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];

export const DUE_BUCKET_LABEL: Readonly<Record<DueBucket, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};

/** Midnight of the given instant, in the viewer's local time zone — matches web's own `startOfDay`. */
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** `now` defaults to the real clock but is overridable — a pinned instant is what makes the bucketing test deterministic, same as `formatDueDate`'s own tests. */
export function dueBucketOf(dueDate: string | null, now: Date = new Date()): DueBucket {
  if (dueDate === null) return 'none';

  const due = startOfDay(new Date(dueDate));
  const today = startOfDay(now);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

export interface DueGroup {
  readonly bucket: DueBucket;
  readonly label: string;
  readonly cards: readonly CardSummary[];
}

/**
 * Buckets `cards` by due date, in display order. Unlike `groupCards`'s
 * other groupings, an EMPTY bucket never appears — "Overdue" is not a
 * standing column the way a board's list/status columns are, so there is
 * no vocabulary entry to keep alive when nothing is in it.
 */
export function groupCardsByDue(
  cards: readonly CardSummary[],
  now: Date = new Date(),
): readonly DueGroup[] {
  const byBucket = new Map<DueBucket, CardSummary[]>();
  for (const card of cards) {
    const bucket = dueBucketOf(card.dueDate, now);
    const existing = byBucket.get(bucket);
    if (existing === undefined) byBucket.set(bucket, [card]);
    else existing.push(card);
  }

  return DUE_BUCKET_ORDER.filter((bucket) => (byBucket.get(bucket) ?? []).length > 0).map(
    (bucket) => ({
      bucket,
      label: DUE_BUCKET_LABEL[bucket],
      cards: byBucket.get(bucket) ?? [],
    }),
  );
}

/**
 * Card-detail vocabulary — status and labels, both PROJECT-scoped (a
 * board's cards share one project's status/label set, the same tier
 * `sprints.ts`'s own header already places sprints at). Derived off the
 * live client, same convention as `CardSummary`/`CardDetail`.
 */
export type StatusSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['statuses']['list']['query']>>
>[number];

export function statusesQueryKey(projectId: string): readonly ['work.statuses.list', string] {
  return ['work.statuses.list', projectId];
}

export type LabelSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['labels']['list']['query']>>
>[number];

export function labelsQueryKey(projectId: string): readonly ['work.labels.list', string] {
  return ['work.labels.list', projectId];
}

/** A card's own labels — `work.labels.onCard`, separate from the project's full set above. */
export function cardLabelsQueryKey(cardId: string): readonly ['work.labels.onCard', string] {
  return ['work.labels.onCard', cardId];
}

/**
 * A fixed swatch set, cycled rather than picked freely — ported verbatim
 * from `apps/web/src/features/work/detail/label-section.tsx`'s own
 * `nextColor`. Deterministic rather than randomized (`Math.random()` is
 * banned workspace-wide, and a crypto RNG for a swatch pick would be
 * absurd) — two labels created in a row read as visibly different rather
 * than occasionally identical.
 *
 * Web's project-settings-page.tsx recolors a label or a status with an
 * `<input type="color">`, which has no RN equivalent; `project-
 * settings.tsx` reuses this same palette as a row of tappable swatches for
 * both, rather than introducing a second one or a native color-picker
 * dependency this app carries nowhere else.
 */
export const LABEL_PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#6366f1',
  '#d946ef',
];

export function nextLabelColor(existing: number): string {
  return LABEL_PALETTE[existing % LABEL_PALETTE.length] ?? '#6366f1';
}

/**
 * A card's checklists, with their items nested — `work.checklists.list`.
 * Unlike status/labels this is CARD-scoped, not project-scoped: each card
 * owns its own checklists outright, so there is no shared vocabulary query
 * the way `statusesQueryKey`/`labelsQueryKey` read one.
 */
export type Checklist = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['checklists']['list']['query']>>
>[number];

export type ChecklistItem = Checklist['items'][number];

export function checklistsQueryKey(cardId: string): readonly ['work.checklists.list', string] {
  return ['work.checklists.list', cardId];
}

/**
 * Custom field definitions and values — PROJECT-scoped vocabulary
 * (`work.fields.list`) plus one card's own values (`work.fields.onCard`),
 * the same two-tier shape `statusesQueryKey`/`labelsQueryKey` already
 * establish. Mirrors `apps/web/src/features/work/detail/
 * custom-field-section.tsx`'s own `FIELD_TYPES` — the server's `z.enum`
 * is the real authority; a drift here is a rejected create, not a bad row.
 */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'multi_select',
  'user',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export type CustomField = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['fields']['list']['query']>>
>[number];

export function fieldsQueryKey(projectId: string): readonly ['work.fields.list', string] {
  return ['work.fields.list', projectId];
}

/**
 * Every field, including archived ones — `work.fields.list` with
 * `includeArchived: true`. A card panel only ever wants the live set
 * (`fieldsQueryKey` above); `project-settings.tsx` is the one place an
 * archived field can be found again and restored, so it needs the wider
 * read under its own cache entry — nested under `fieldsQueryKey`'s own key
 * family (mirroring `archivedListsQuery`'s own precedent on web) so
 * archiving or restoring a field, which already invalidates that family,
 * refreshes this one too with no second invalidation to remember.
 */
export function allFieldsQueryKey(projectId: string): readonly ['work.fields.list', string, 'all'] {
  return ['work.fields.list', projectId, 'all'];
}

export type CardFieldValue = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['fields']['onCard']['query']>>
>[number];

export function cardFieldsQueryKey(cardId: string): readonly ['work.fields.onCard', string] {
  return ['work.fields.onCard', cardId];
}

/** A card's attachments — `work.attachments.list`. */
export type Attachment = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['attachments']['list']['query']>>
>[number];

export function attachmentsQueryKey(cardId: string): readonly ['work.attachments.list', string] {
  return ['work.attachments.list', cardId];
}

/**
 * A byte count for an attachment row — `apps/web/src/lib/format.ts`'s
 * `formatBytes`, verbatim logic. Decimal units, matching what operating
 * systems show for downloads; bytes shown exactly rather than rounded, so
 * a 40-byte file does not read as an upload failure ("0.0 KB").
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** A card's comments — read + post only on native for now; see card/[cardId].tsx's own header. */
export type Comment = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['comments']['list']['query']>>
>[number];

export function commentsQueryKey(cardId: string): readonly ['work.comments.list', string] {
  return ['work.comments.list', cardId];
}

// ---------------------------------------------------------------------------
// Pull requests, branches, repos
// ---------------------------------------------------------------------------

/** A linked pull request — `work.pullRequests.list`. */
export type PullRequestLink = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['pullRequests']['list']['query']>>
>[number];

export function cardPullRequestsQueryKey(
  cardId: string,
): readonly ['work.pullRequests.list', string] {
  return ['work.pullRequests.list', cardId];
}

/** A linked branch — `work.branches.list`. */
export type BranchLink = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['branches']['list']['query']>>
>[number];

export function cardBranchesQueryKey(cardId: string): readonly ['work.branches.list', string] {
  return ['work.branches.list', cardId];
}

/** Connected GitHub repos — `work.githubRepos.list`. */
export interface ConnectedRepo {
  readonly providerScope: string;
}

export const GITHUB_REPOS_QUERY_KEY = ['work.githubRepos.list'] as const;

export function githubReposQueryKey(): typeof GITHUB_REPOS_QUERY_KEY {
  return GITHUB_REPOS_QUERY_KEY;
}
