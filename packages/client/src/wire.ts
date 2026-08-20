/**
 * What the server's types promise, and what the wire actually delivers.
 *
 * Shared rather than kept in `apps/web` alone (ai/phase-14-mobile.md §5, §12
 * decision 4): the lie this file corrects for — a tRPC client inferring
 * `Date` from `z.date()` when the wire actually carries a JSON string — is
 * identical on every client this monorepo ships, `apps/mobile` included.
 * Copying it per app is exactly the drift guardrail 5 exists to rule out.
 *
 * ## The problem
 *
 * The API's route outputs are declared with Zod, and several of them use
 * `z.date()` — `cards.list` returns `dueDate: z.date().nullable()`. tRPC infers
 * the client type from those schemas, so `card.dueDate` is typed `Date | null`.
 *
 * There is no transformer configured on either side (apps/api/src/trpc/builder.ts
 * calls `initTRPC.create()` with no `transformer`), so the response is plain
 * JSON. `JSON.stringify(new Date())` is a STRING. The value that arrives is
 * `"2026-03-01T09:00:00.000Z"`, typed `Date`.
 *
 * Nothing fails. `card.dueDate.getTime()` throws at runtime; `format(dueDate)`
 * from date-fns silently produces `"Invalid Date"`; a sort comparing them
 * compares `undefined`. Guardrail 5 says the generated client makes the API
 * contract a compile-time fact — a type that is wrong about its own wire format
 * is the one hole in that, and it is invisible because the compiler agrees with
 * the lie.
 *
 * ## The fix
 *
 * `Wire<T>` restates a server type as what JSON delivers, and `wire()` is the
 * one place the correction is applied. It does nothing at runtime — the value is
 * already a string, and always was. What it changes is that the compiler now
 * knows, so `format(card.dueDate)` stops compiling and `parseInstant()` is
 * forced at the point of use.
 *
 * ## Why not superjson
 *
 * A transformer on both sides would make the runtime match the existing types,
 * which is the more usual answer. It also changes the wire encoding of every
 * request and response — inputs become `{"json": ...}` — and apps/api's HTTP
 * tests post raw payloads through `app.inject`. That is a change to a verified
 * backend for the benefit of the frontend, so it belongs in a deliberate pass of
 * its own rather than smuggled in with the first app to consume the API. When it
 * happens, `Wire` collapses to identity and every `wire()` call site is a
 * greppable list of what to delete.
 */

/**
 * A server output type, restated as the JSON that actually arrives.
 *
 * Distributes over unions, so `Date | null` becomes `string | null` rather than
 * collapsing — which matters because nullable timestamps are most of them.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer Element)[]
    ? readonly Wire<Element>[]
    : T extends object
      ? { readonly [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * Corrects the type of a value that has already crossed the wire.
 *
 * A no-op at runtime, on purpose: the conversion happened in `JSON.stringify` on
 * the server, and this is the assertion that the client's type finally agrees
 * with it. The double cast is unavoidable — `T` and `Wire<T>` do not overlap
 * where they differ, which is exactly the point being made.
 *
 * Call it once, at the boundary, on everything returned from the tRPC client.
 */
export function wire<T>(value: T): Wire<T> {
  return value as unknown as Wire<T>;
}

/**
 * Parses a wire timestamp into a `Date`.
 *
 * `new Date(string)` rather than `parseISO` because the server emits
 * `toJSON()` output, which is always a full ISO-8601 instant in UTC — the format
 * both agree on. An unparseable value throws instead of yielding an Invalid
 * Date: a silent NaN propagates into a sort comparator and reorders a board
 * without any error being raised anywhere.
 */
export function parseInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Expected an ISO-8601 timestamp from the API, received "${value}".`);
  }
  return parsed;
}

/** `parseInstant` for a nullable column. */
export function parseNullableInstant(value: string | null): Date | null {
  return value === null ? null : parseInstant(value);
}
