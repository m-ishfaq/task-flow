/**
 * The notification preference matrix — categories, defaults, and resolution
 * (Phase 9, ai/phase-9-notifications.md §3.3).
 *
 * Pure and database-free on purpose, the same reason `packages/feature-flags`'
 * evaluator is: "does this user get this channel" is a decision with judgment
 * in it, and it should be testable without a transaction. It is not that
 * package, and must not become it — guardrail 7 is explicit that flags gate
 * product surface only, and a notification preference is a person's own
 * choice, not a release gate or a security control.
 */

export type NotificationCategory = 'direct' | 'activity';
export type NotificationChannel = 'email' | 'push' | 'sms';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ['direct', 'activity'];
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['email', 'push', 'sms'];

/**
 * Which category a kind belongs to.
 *
 * A short, closed, reviewed list — the same shape `PROJECT_SCOPED_PREFIXES`
 * takes in `apps/realtime/src/event-rooms.ts` — never a caller-supplied
 * value. A kind absent from this table (a bug, since every registered kind
 * should appear here) falls back to `activity`, the more conservative of the
 * two defaults, rather than throwing and dropping the notification.
 */
const CATEGORY_OF_KIND: Readonly<Record<string, NotificationCategory>> = {
  'chat.mention': 'direct',
  'chat.direct': 'direct',
  'chat.thread_reply': 'activity',
  'card.assigned': 'direct',
  'card.comment_mention': 'direct',
  'card.due_soon': 'activity',
  'page.comment_mention': 'direct',
};

export function categoryOfKind(kind: string): NotificationCategory {
  return CATEGORY_OF_KIND[kind] ?? 'activity';
}

/**
 * Every kind that belongs to the `activity` category, as a closed list.
 *
 * The digest sweep's query filters pending email deliveries on exactly these
 * kinds — a `direct` mention must never sit in a digest waiting for the daily
 * sweep (§3.4). Derived from the same table `categoryOfKind` reads, so a kind
 * added to `activity` is picked up here without a second edit.
 */
export const ACTIVITY_KINDS: readonly string[] = Object.entries(CATEGORY_OF_KIND)
  .filter(([, category]) => category === 'activity')
  .map(([kind]) => kind);

/**
 * Coded defaults, consulted when no explicit row exists — exactly like
 * `FLAGS`' `defaultValue` (`packages/feature-flags/src/flags.ts`). Nobody
 * backfills a row per user per category per channel on migration; absence
 * IS the default.
 */
const DEFAULTS: Readonly<
  Record<NotificationCategory, Readonly<Record<NotificationChannel, boolean>>>
> = {
  direct: { email: true, push: true, sms: false },
  activity: { email: false, push: false, sms: false },
};

export interface ExplicitPref {
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

/**
 * Whether a user should be notified on this category/channel, given whatever
 * explicit rows they have. An explicit row always wins; its absence falls
 * back to `DEFAULTS`.
 */
export function resolvePref(
  explicit: readonly ExplicitPref[],
  category: NotificationCategory,
  channel: NotificationChannel,
): boolean {
  for (const row of explicit) {
    if (row.category === category && row.channel === channel) return row.enabled;
  }
  return DEFAULTS[category][channel];
}
