import { format } from 'date-fns';

/**
 * Pure `Date` <-> wire-string conversions for `date-picker-field.tsx`, split
 * into their own plain `.ts` file for the same reason `message-compose.ts`
 * is split from `message-composer.tsx`: `date-picker-field.tsx` statically
 * imports `react-native` and `@react-native-community/datetimepicker`, and
 * `use-call.ts`'s own header already established that `react-native`'s
 * source fails to even PARSE under Vitest — so a test file importing THIS
 * module must never drag that one in with it. Keeping the pure conversions
 * here, with no react-native import anywhere in this file, is what lets
 * `date-picker.test.ts` exist at all.
 *
 * ## Two wire shapes, because the server has two
 *
 * A card's `dueDate`/`startDate` and a `date`-type custom field are all
 * `z.date()` server-side — a full INSTANT, serialized as an ISO string
 * (`@taskflow/client`'s `parseNullableInstant` already parses these). A
 * sprint's `startsOn`/`endsOn` are the `Day` contract type instead — a plain
 * `YYYY-MM-DD` string with no time or zone component at all
 * (`apps/api/src/work/router.ts`). The native picker returns the same kind
 * of value either way — a `Date` object at LOCAL midnight for the picked
 * day — so `dateToIsoInstant` and `dateToPlainDay` both start from that one
 * `Date` and diverge only in how they serialize it; the picker component
 * itself never needs to know which wire shape a caller wants.
 */

/**
 * `Date` -> the ISO instant string `dueDate`/`startDate`/a `date`-type
 * custom field send over the wire. The native picker already hands back a
 * `Date` at local midnight for the picked day, so this is a direct
 * `.toISOString()` — the exact value the hand-typed `${trimmed}T00:00:00}`
 * parse this component replaces already produced from the same input.
 */
export function dateToIsoInstant(date: Date): string {
  return date.toISOString();
}

/**
 * `Date` -> the plain `YYYY-MM-DD` string a sprint's `startsOn`/`endsOn`
 * expects. Built from the LOCAL calendar fields (`getFullYear`/`getMonth`/
 * `getDate`), never `.toISOString().slice(0, 10)` — that reads the UTC day,
 * which names the WRONG calendar day for anyone west of UTC picking a date
 * near local midnight (23:30 local on the 23rd is already the 24th in UTC).
 */
export function dateToPlainDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The inverse of `dateToPlainDay` — parses a `YYYY-MM-DD` string as LOCAL
 * midnight, matching this app's existing `${trimmed}T00:00:00}` pattern
 * rather than `new Date(value)` alone: the JS `Date` constructor parses a
 * bare date-only ISO string (no `T`) as UTC midnight, which is a different
 * instant than local midnight everywhere except UTC+0 — the same class of
 * bug `dateToPlainDay`'s own header describes in the other direction.
 */
export function plainDayToDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

/** The picker trigger's own display text — "23 Aug 2026", matching
 *  `work.ts`'s `formatDueDate` use of `date-fns`'s `format` for every other
 *  date shown in this app, rather than a second ad hoc format string. */
export function formatPickedDate(date: Date): string {
  return format(date, 'd MMM yyyy');
}
