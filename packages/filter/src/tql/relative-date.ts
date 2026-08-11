/**
 * Symbolic date literals for TQL (ai/phase-8-search.md §1.5).
 *
 * ## Why dates stay symbolic until compile time
 *
 * `updated > -7d` must mean "updated in the last seven days AS OF WHEN THE QUERY
 * RUNS", not when it was typed. `view.service.ts` records the identical reasoning
 * for `@me`: *"Resolving it at save time would make a shared 'assigned to me'
 * view mean 'assigned to whoever saved it'."* A saved query whose dates resolved
 * at parse time goes stale in a week, and a shared one means something different
 * to everyone who opens it.
 *
 * So the parser emits the literals below as plain string values — `'-7d'`,
 * `'@today'` — which `validate` accepts through `isSymbolicDate`, and
 * `compile`/`evaluate` resolve against an injectable `now` (`CompileOptions.now`
 * / `EvaluateOptions.now`, the `@me`/`viewerId` precedent extended with a clock
 * so tests are deterministic). The AST itself never contains a resolved
 * timestamp, so the same tree compiles in Postgres and evaluates in JavaScript
 * to the same answer by construction.
 *
 * ## The closed vocabulary
 *
 *   `@now`    — this instant
 *   `@today`  — start of the current day, UTC
 *   `-Nd`     — N days ago          `+Nd`     — N days from now
 *   `-Nw`     — N weeks ago         `+Nw`     — N weeks from now
 *   `-Nmo`    — N months ago        `+Nmo`    — N months from now
 *
 * `@today` is UTC by decision, not by accident: the codebase stores timestamptz
 * and compares instants, and a per-user "start of my day" needs a timezone this
 * phase does not have (Phase 11.5's canonical timezone is where that lives).
 * Documented here so the limitation is a decision, not an oversight.
 *
 * Natural-language dates (`"next friday"`) are deliberately NOT here — they
 * cannot be represented symbolically, and PLAN.md's one example line is not a
 * feature request.
 */

export const TODAY = '@today';
export const NOW = '@now';

/** `-7d`, `+3w`, `-2mo` — signed integer offsets with a unit, captured. */
const RELATIVE_OFFSET_RE = /^([+-])(\d+)(d|w|mo)$/;

/** The whole closed vocabulary: `@today`, `@now`, or a signed offset. */
const SYMBOLIC_RE = /^(?:@today|@now|[+-]\d+(?:d|w|mo))$/;

/** True when `value` is one of the symbolic date literals. */
export function isSymbolicDate(value: string): boolean {
  return SYMBOLIC_RE.test(value);
}

/**
 * Resolves a symbolic date to an ISO timestamp against `now`.
 *
 * Returns null when the value is not symbolic, so a caller can fall through to
 * ordinary handling without guessing. `mo` is a calendar month (via `setUTCMonth`),
 * because that is what a person means by "a month ago" — the same choice the
 * notification sweeps make for their windows.
 */
export function resolveSymbolicDate(value: string, now: Date): string | null {
  if (value === TODAY) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (value === NOW) return now.toISOString();

  const match = RELATIVE_OFFSET_RE.exec(value);
  if (!match) return null;

  const sign = match[1] === '-' ? -1 : 1;
  const amount = Number(match[2]);
  const unit = match[3];

  const result = new Date(now);
  if (unit === 'd') {
    result.setUTCDate(result.getUTCDate() + sign * amount);
  } else if (unit === 'w') {
    result.setUTCDate(result.getUTCDate() + sign * amount * 7);
  } else {
    result.setUTCMonth(result.getUTCMonth() + sign * amount);
  }
  return result.toISOString();
}
