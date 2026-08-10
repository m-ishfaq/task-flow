import { format, formatDistanceToNowStrict, isToday, isTomorrow, isPast, isAfter } from 'date-fns';
import { parseInstant, parseNullableInstant } from './wire.js';

/**
 * Presentation of times and dates.
 *
 * Everything here takes the WIRE representation — an ISO string — rather than a
 * `Date`, because that is what actually arrives (see wire.ts) and converting at
 * the point of display keeps the parse in one place.
 *
 * Timezone: the browser's, deliberately. A due date means "end of day where the
 * person reading it is", and PLAN.md §4.1 pairs date-fns with `@date-fns/tz` for
 * the cases where that is not good enough — working hours and scheduling in
 * Phase 6, where the relevant zone is the ORGANIZATION's and not the viewer's.
 * Work due dates are not one of those cases.
 */

export function formatDate(value: string): string {
  return format(parseInstant(value), 'd MMM yyyy');
}

export function formatDateTime(value: string): string {
  return format(parseInstant(value), 'd MMM yyyy, HH:mm');
}

/** "3 minutes ago". For activity feeds and comment timestamps. */
export function formatRelative(value: string): string {
  return `${formatDistanceToNowStrict(parseInstant(value))} ago`;
}

export interface DueDateDisplay {
  readonly label: string;
  /** Whether the date has passed. Drives the colour, never the meaning. */
  readonly overdue: boolean;
}

/**
 * A due date as a board badge.
 *
 * "Today" and "Tomorrow" rather than a date, because the question a board
 * answers is "what is urgent", and a reader should not have to compare two dates
 * mentally to find out.
 */
export function formatDueDate(value: string | null): DueDateDisplay | null {
  const due = parseNullableInstant(value);
  if (due === null) return null;

  const label = isToday(due) ? 'Today' : isTomorrow(due) ? 'Tomorrow' : format(due, 'd MMM');
  return { label, overdue: isPast(due) && !isToday(due) };
}

/**
 * A byte count for an attachment row.
 *
 * Decimal units, matching what operating systems show for downloads. Bytes are
 * shown exactly — rounding a 40-byte file to "0.0 KB" reads as an upload
 * failure.
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

/**
 * A call duration as "3m 12s", or "45s" under a minute — never "0m 12s".
 *
 * For a FINISHED call's length. An in-progress call ticks its own elapsed
 * time client-side from a locally captured start instant rather than reading
 * one from the server — see `features/rtc/call-surface.tsx`.
 */
export function formatCallDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0
    ? `${String(remainder)}s`
    : `${String(minutes)}m ${String(remainder).padStart(2, '0')}s`;
}

/**
 * An integer-cents amount, as USD.
 *
 * Every telephony money value is `CentsSchema` — an integer, never a float
 * (`packages/contracts/src/telephony.ts`) — so this divides by 100 only at the
 * point of display, the one place a rounding error is harmless. `Intl` rather
 * than hand-built string math, for the same reason `formatBytes` does not
 * reinvent unit suffixes: locale-correct grouping and decimal points are not
 * worth re-deriving.
 */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * A person's display name from whatever the API returned.
 *
 * `name` is optional because `tenancy.members.list` does not return one today —
 * memberships carry an email and a role. Falling back to the email is better
 * than "Unknown", which is indistinguishable from a data-loading bug.
 */
export interface Person {
  readonly name?: string | null;
  readonly email: string;
}

export function displayName(person: Person): string {
  const name = person.name;
  return name !== null && name !== undefined && name.trim() !== '' ? name : person.email;
}

/** Two letters for an avatar. */
export function initials(person: Person): string {
  const source = displayName(person).trim();
  const parts = source.split(/\s+/).filter((part) => part.length > 0);

  const first = parts[0]?.charAt(0) ?? '?';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';

  return (first + second).toUpperCase();
}

/**
 * A person's out-of-office state, as the directory shows it.
 *
 * "Active" means the person is OOO RIGHT NOW: a return date exists and has
 * not passed, and a scheduled start (if any) has begun. A future OOO is not
 * active — the directory must not badge someone as out while they are still
 * working (§7 decision: OOO can be planned in advance). `null` means not out.
 *
 * Lives here, not in the component, for the same reason `formatDueDate` does:
 * `isAfter`/`isPast` consult the clock, and the React Compiler purity rule
 * flags `Date.now()` called directly in a render body — the lib boundary is
 * where the clock lives.
 */
export function oooStatus(oooFrom: string | null, oooUntil: string | null): boolean {
  const until = parseNullableInstant(oooUntil);
  if (until === null) return false;

  /* Active only while the return date is still ahead. */
  if (!isAfter(until, new Date())) return false;

  /* A scheduled start that has not begun is a FUTURE OOO — not out yet. */
  const from = parseNullableInstant(oooFrom);
  return from === null || isPast(from);
}
