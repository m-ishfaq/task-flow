/**
 * Fractional indexing — card and list ordering (PLAN.md §10.1).
 *
 * Lists and cards carry `rank: string`, sorted lexicographically within their
 * parent. Inserting between two neighbours generates a string strictly between
 * their ranks, so a drag is a SINGLE-ROW write and no neighbour is touched.
 *
 * The alternative — integer positions renumbered on every move — is why
 * drag-and-drop in a collaborative board is hard. Two people dragging at once
 * each rewrite the same rows, one of them wins, and the loser's card jumps back
 * under their cursor. Here the two writes touch different rows and both survive.
 *
 * ## Why a rank is two parts and not one fraction
 *
 * The obvious implementation — treat the string as the digits after `0.` and
 * bisect — is correct and unusable. Bisecting toward an endpoint adds a digit
 * every ~6 insertions, so appending 10,000 cards to a list gives the last one a
 * rank about 1,600 characters long. Appending is not an adversarial case; it is
 * what every user does all day.
 *
 * So a rank is `<integer><fraction>`, and appending INCREMENTS THE INTEGER
 * rather than bisecting toward infinity. Sequential insertion at either end
 * grows the rank as log₆₂(n) — four characters at ten thousand cards — and the
 * fraction is only reached when someone inserts repeatedly between two
 * neighbours that are already adjacent integers.
 *
 * The integer is self-describing: its first character encodes both sign and
 * length, so `integerPartOf` can split a rank with no separator character.
 * Lowercase heads `a`–`z` are non-negative and describe lengths 2–27; uppercase
 * `Z`–`A` are negative and describe the same lengths. Because ASCII orders
 * `0`–`9` < `A`–`Z` < `a`–`z`, a longer negative integer sorts below a shorter
 * one and every non-negative sorts above every negative — which is what makes
 * lexicographic comparison agree with numeric order across the sign change.
 *
 * ## The alphabet is load-bearing
 *
 * Digits are ASCII-ordered, so a lexicographic comparison of two rank strings
 * agrees with a comparison of the values they denote. That is what lets Postgres
 * sort with a plain `ORDER BY rank` and a plain btree index, with no
 * collation-dependent behaviour: every character here is ASCII-alphanumeric,
 * where every collation agrees.
 *
 * ## The invariant every rank satisfies
 *
 * A valid rank is a well-formed integer part followed by a fraction that does
 * NOT end in the zero digit. Trailing zeros are banned because they make the
 * representation ambiguous — `a0V` and `a0V0` would denote the same value — and
 * ambiguity breaks the one property the scheme rests on. `isRank` enforces it,
 * and every function here both requires and preserves it.
 *
 * ## Ranks are not unique
 *
 * Two clients inserting at the same point concurrently can generate the same
 * string; neither read the other's write. That is expected rather than
 * prevented — preventing it would need the locking this design exists to avoid.
 * Every query orders by `(rank, id)`, which is total and deterministic because
 * ids are unique, so the two clients converge on the same order instead of
 * disagreeing about it.
 */

/**
 * 62 digits in ASCII order.
 *
 * Do not reorder. The sort correctness argument above is a statement about THIS
 * string being ascending in ASCII, and nothing else in the system re-checks it.
 */
export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const BASE = RANK_DIGITS.length;
const ZERO = RANK_DIGITS.charAt(0);
const LAST = RANK_DIGITS.charAt(BASE - 1);

/** Index of a digit, or -1. Cheaper and clearer than a Map at 62 entries. */
function digitValue(char: string): number {
  return RANK_DIGITS.indexOf(char);
}

/**
 * The digit at `value`.
 *
 * `charAt` rather than indexing because `noUncheckedIndexedAccess` types the
 * latter as possibly-undefined, and every caller here has already bounded the
 * value — so the alternative is a non-null assertion at eight call sites, which
 * is exactly the pattern that stops being checked once it is habitual.
 */
function digitAt(value: number): string {
  return RANK_DIGITS.charAt(value);
}

/** The integer denoting zero, and the rank of the first item in an empty list. */
const ZERO_INTEGER = `a${ZERO}`;

/** The most negative integer the encoding can express — 27 characters. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

/**
 * The length past which a list should be renormalized.
 *
 * With the integer part doing the work, ranks lengthen only under repeated
 * insertion at the SAME point between two adjacent neighbours — dropping card
 * after card into the identical gap. Ordinary use keeps ranks at two to five
 * characters essentially forever, so this is a pathology detector, not a routine
 * maintenance trigger.
 */
export const RANK_REBALANCE_THRESHOLD = 24;

export class InvalidRankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRankError';
  }
}

/* -------------------------------------------------------------------------- *
 * The integer part
 * -------------------------------------------------------------------------- */

/**
 * Total length of the integer whose first character is `head`, or -1 when
 * `head` does not describe one.
 *
 * `a` is 2 characters and each later letter one more, up to `z` at 27; the
 * uppercase range mirrors it downward from `Z` so that a MORE negative integer
 * is both longer and lexicographically smaller.
 */
function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return -1;
}

/**
 * Splits the integer part off the front of a rank.
 *
 * Throws rather than returning a fallback: a rank whose head is not a valid
 * length marker is corrupt, and guessing a split would produce neighbouring
 * ranks that sort into positions nobody chose.
 */
function integerPartOf(rank: string): string {
  const length = integerLength(rank.charAt(0));
  if (length < 0 || length > rank.length) {
    throw new InvalidRankError(`Rank ${JSON.stringify(rank)} has no well-formed integer part.`);
  }
  return rank.slice(0, length);
}

/**
 * The next integer after `x`, or null when the encoding is exhausted.
 *
 * Null is a real outcome rather than a thrown error because the caller has
 * something useful to do with it — fall back to extending the fraction — and
 * running out of positive integers takes 62²⁷ appends, so the branch exists for
 * completeness rather than because it will be reached.
 */
function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');

  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    /* Read from `x` rather than from `digits`: the loop writes each position at
       most once, immediately after reading it, so the original string still
       holds every value this needs — and reading it avoids an indexed access
       the compiler has to be told is in bounds. */
    const next = digitValue(x.charAt(index + 1)) + 1;
    if (next === BASE) {
      digits[index] = ZERO;
    } else {
      digits[index] = digitAt(next);
      carry = false;
    }
  }

  if (!carry) return head + digits.join('');

  // The digits wrapped, so the integer needs a different head. Crossing from
  // the negative range to the non-negative one SHORTENS it; moving further up
  // the non-negative range lengthens it.
  if (head === 'Z') return ZERO_INTEGER;
  if (head === 'z') return null;

  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

/** The previous integer before `x`, or null when the encoding is exhausted. */
function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');

  let borrow = true;
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    // Same read-once/write-once argument as incrementInteger.
    const next = digitValue(x.charAt(index + 1)) - 1;
    if (next === -1) {
      digits[index] = LAST;
    } else {
      digits[index] = digitAt(next);
      borrow = false;
    }
  }

  if (!borrow) return head + digits.join('');

  if (head === 'a') return `Z${LAST}`;
  if (head === 'A') return null;

  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < 'Z') digits.push(LAST);
  else digits.pop();
  return nextHead + digits.join('');
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

/**
 * True when `value` is a well-formed rank.
 *
 * Applied to ranks read from the database as well as ranks arriving from a
 * client, because the failure mode of a malformed one is silent: it sorts into
 * the wrong place and `between` starts producing values that do not lie where
 * they claim to. That is a data corruption bug that presents as "the board is
 * shuffled", months later, with no error anywhere.
 */
export function isRank(value: string): boolean {
  if (value.length === 0) return false;

  const length = integerLength(value.charAt(0));
  if (length < 0 || length > value.length) return false;

  for (const char of value) {
    if (digitValue(char) < 0) return false;
  }

  // Only the FRACTION may not end in zero. The integer part is fixed-width, so
  // `a0` is unambiguous and `a00` — integer `a0`, fraction `0` — is not.
  const fraction = value.slice(length);
  return !fraction.endsWith(ZERO);
}

function requireRank(value: string, label: string): void {
  if (!isRank(value)) {
    throw new InvalidRankError(`${label} is not a valid rank: ${JSON.stringify(value)}`);
  }
}

/* -------------------------------------------------------------------------- *
 * Generation
 * -------------------------------------------------------------------------- */

/**
 * A rank strictly between `before` and `after`.
 *
 * `before === null` means "the start of the list" and `after === null` means
 * "the end", so the four combinations cover every insertion position including
 * the first card in an empty list.
 *
 * Throws when `before >= after`. That is not a defensive assertion for an
 * impossible case — it is reachable whenever a caller passes neighbours in the
 * wrong order, or passes two cards that are not actually adjacent. Returning
 * something plausible instead would place the card somewhere the user did not
 * drop it and leave no trace of why.
 */
export function between(before: string | null, after: string | null): string {
  if (before !== null) requireRank(before, 'before');
  if (after !== null) requireRank(after, 'after');

  if (before !== null && after !== null && before >= after) {
    throw new InvalidRankError(
      `Cannot generate a rank between ${JSON.stringify(before)} and ${JSON.stringify(after)}: ` +
        'the neighbours are equal or out of order.',
    );
  }

  if (before === null) {
    if (after === null) return ZERO_INTEGER;
    return beforeRank(after);
  }

  if (after === null) return afterRank(before);

  const integerBefore = integerPartOf(before);
  const integerAfter = integerPartOf(after);

  // Same integer: the gap is entirely inside the fraction.
  if (integerBefore === integerAfter) {
    return (
      integerBefore + midpoint(before.slice(integerBefore.length), after.slice(integerAfter.length))
    );
  }

  // Different integers: if the next one up is still below `after`, it is the
  // shortest rank in the gap. Otherwise `after` is the very next integer and the
  // room is again in `before`'s fraction.
  const incremented = incrementInteger(integerBefore);
  if (incremented === null) {
    throw new InvalidRankError('Rank space exhausted above; the list needs a rebalance.');
  }
  if (incremented < after) return incremented;

  return integerBefore + midpoint(before.slice(integerBefore.length), null);
}

/** A rank below `after`, with nothing before it. */
function beforeRank(after: string): string {
  const integer = integerPartOf(after);
  const fraction = after.slice(integer.length);

  // No smaller integer exists, so the only room left is below `after`'s
  // fraction. This is where prepending finally starts lengthening ranks, after
  // roughly 62²⁷ of them.
  if (integer === SMALLEST_INTEGER) return integer + midpoint('', fraction);

  // `after` carries a fraction, so its own integer already sits below it and is
  // shorter than anything a decrement would produce.
  if (integer < after) return integer;

  const decremented = decrementInteger(integer);
  if (decremented === null) {
    throw new InvalidRankError('Rank space exhausted below; the list needs a rebalance.');
  }
  return decremented;
}

/** A rank above `before`, with nothing after it. */
function afterRank(before: string): string {
  const integer = integerPartOf(before);
  const incremented = incrementInteger(integer);

  if (incremented !== null) return incremented;
  return integer + midpoint(before.slice(integer.length), null);
}

/**
 * The midpoint of two fractional digit-strings, where `''` denotes 0 and `null`
 * denotes 1.
 *
 * Both arguments are the part after the integer, so `'V'` is 31/62 and `'0V'` is
 * 31/3844. The recursion copies the shared prefix and then works on the first
 * position where the two differ, which is what keeps the result short: only the
 * digits that actually distinguish the neighbours are examined.
 *
 * Requires `a < b` and both free of trailing zeros; every caller has already
 * established that. Returns a string that is itself free of trailing zeros — see
 * the note on each `return`, because that property is what makes the NEXT call
 * correct.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    /* Copy the common prefix and recurse on what remains. Missing positions in
       `a` read as the zero digit, which is what `a` being shorter than `b`
       means numerically. */
    let shared = 0;
    while (
      shared < b.length &&
      (shared < a.length ? a.charAt(shared) : ZERO) === b.charAt(shared)
    ) {
      shared += 1;
    }

    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
  }

  const low = a === '' ? 0 : digitValue(a.charAt(0));
  const high = b === null ? BASE : digitValue(b.charAt(0));

  if (high - low > 1) {
    /* A digit fits between them. It cannot be the zero digit: `low >= 0` and
       `high > low + 1` force the rounded midpoint to at least 1. */
    const mid = Math.round(0.5 * (low + high));
    return digitAt(mid);
  }

  if (b !== null && b.length > 1) {
    /* The digits are adjacent, but `b` has more after its first, so `b`'s first
       digit alone sits between them: it exceeds `a`'s first digit, and it is a
       strict prefix of `b`. It is never the zero digit, because `low < high`
       forces `high >= 1`. */
    return b.slice(0, 1);
  }

  /* Adjacent digits with no room in `b` — keep `a`'s digit and find a position
     beyond `a`'s remaining precision. The tail is a midpoint against 1, which
     always ends in a non-zero digit by the first branch above. */
  return digitAt(low) + midpoint(a.slice(1), null);
}

/** The rank for the first item in an empty list. */
export function initialRank(): string {
  return ZERO_INTEGER;
}

/**
 * `count` ascending ranks, evenly spaced.
 *
 * Used to seed a list from a template and by the rebalance job, which rewrites
 * every row rather than nudging the offenders — a partial renormalization leaves
 * the long ranks it was run to remove.
 *
 * Consecutive integers, so every adjacent pair has an entire fraction space
 * between it and the ranks stay log₆₂(count) long.
 */
export function rankSequence(count: number): readonly string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidRankError(`rankSequence needs a non-negative integer, got ${String(count)}`);
  }

  const ranks: string[] = [];
  let cursor: string | null = null;

  for (let index = 0; index < count; index += 1) {
    cursor = between(cursor, null);
    ranks.push(cursor);
  }
  return ranks;
}

/**
 * True when a list's ranks have degenerated far enough to be worth rewriting.
 *
 * Takes the ranks rather than a count because length is the symptom that
 * matters. A thousand cards with four-character ranks are fine; twenty cards
 * where one rank is forty characters long are not.
 */
export function needsRebalance(ranks: readonly string[]): boolean {
  return ranks.some((rank) => rank.length >= RANK_REBALANCE_THRESHOLD);
}

/**
 * Orders by `(rank, id)` — the comparator every query and every client-side
 * sort must use.
 *
 * The `id` tiebreak is not cosmetic. Concurrent inserts at the same point
 * produce equal ranks, and without a deterministic second key two clients
 * holding the same rows would render them in different orders, which looks
 * exactly like a synchronization bug and is impossible to reproduce.
 */
export function compareRanked(
  a: { readonly rank: string; readonly id: string },
  b: { readonly rank: string; readonly id: string },
): number {
  if (a.rank < b.rank) return -1;
  if (a.rank > b.rank) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
