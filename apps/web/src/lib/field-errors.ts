import { apiErrorOf } from './trpc.js';

/**
 * The per-field reasons the server sent, if it sent any.
 *
 * `details` is populated for VALIDATION_FAILED by the API's error formatter
 * (apps/api/src/trpc/builder.ts), keyed by field path. Rendering it is the
 * difference between "The request was not valid." and "password: String must
 * contain at least 12 character(s)" — the server always knew which field, and a
 * display layer that drops it makes the user guess at a rule they were shown two
 * lines above the input.
 *
 * The rule itself is NEVER restated on this side. `Password` is
 * `z.string().min(12)` in the API's router and nowhere else; a `minLength: 12`
 * in a form would be a second copy of that number, free to drift the moment the
 * policy changes — and the copy users see would be the one nobody tests.
 *
 * Values are read defensively rather than cast: `details` is
 * `Record<string, unknown>` on the wire, and a non-string should render nothing
 * rather than `[object Object]`.
 */
export function fieldErrors(error: unknown): readonly (readonly [string, string])[] {
  const details = apiErrorOf(error)?.error.details;
  if (details === undefined) return [];

  return Object.entries(details).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

/** The reason for one named field, for rendering next to its input. */
export function fieldError(error: unknown, field: string): string | undefined {
  return fieldErrors(error).find(([name]) => name === field)?.[1];
}
