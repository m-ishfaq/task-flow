import { ME, type FilterNode, type FilterValue } from './ast.js';
import { findField, type FieldDefinition, type Resource } from './fields.js';

/**
 * The in-memory evaluator (PLAN.md §10.2).
 *
 * The second frontend onto the same AST:
 *
 *   Phase 3   visual builder ──► AST ──► SQL compiler      (board views)
 *   Phase 10  automation      ──► AST ──► THIS             (rule conditions)
 *
 * ## The property that matters
 *
 * **This must agree with the compiler.** An automation rule and a board filter
 * built from the same tree have to select the same cards, or a rule fires on
 * work the user cannot see in the view that supposedly describes it — and that
 * disagreement is invisible until someone compares them by hand.
 *
 * Agreement is not automatic, because SQL and JavaScript disagree by default in
 * exactly the places filters live:
 *
 *   - SQL is three-valued. `NULL = 5` is UNKNOWN, not false, and `NOT UNKNOWN`
 *     is UNKNOWN — so a row with a null due date matches neither `due < x` nor
 *     its negation. JavaScript has no such notion, so nullity is handled
 *     explicitly here and `NOT` mirrors the compiler's COALESCE.
 *   - `ILIKE` is case-insensitive; `includes` is not.
 *   - Postgres compares timestamps as instants; JavaScript compares ISO strings
 *     as text, which disagrees the moment one has a timezone offset and the
 *     other has `Z`.
 *
 * Each of those is handled below, and `parity.test.ts` is what keeps them
 * honest by running both against the same rows.
 */

/** A row, as the evaluator sees it. Keys are FIELD names, not column names. */
export type EvaluableRow = Readonly<Record<string, unknown>>;

export interface EvaluateOptions {
  /** Substituted for `@me`. */
  readonly viewerId?: string;
}

/**
 * True when `row` satisfies `node`.
 *
 * Returns a plain boolean rather than a tri-state, matching what a WHERE clause
 * ultimately does — a row either comes back or it does not.
 */
export function evaluate(
  resource: Resource,
  node: FilterNode,
  row: EvaluableRow,
  options: EvaluateOptions = {},
): boolean {
  if (node.kind === 'group') {
    if (node.children.length === 0) return node.combinator === 'and';

    return node.combinator === 'and'
      ? node.children.every((child) => evaluate(resource, child, row, options))
      : node.children.some((child) => evaluate(resource, child, row, options));
  }

  if (node.kind === 'not') {
    // Mirrors the compiler's `NOT COALESCE(x, FALSE)`: an unknown is not a
    // match, so its negation is.
    return !evaluate(resource, node.child, row, options);
  }

  const field = findField(resource, node.field);
  // Unknown field matches nothing. The compiler throws instead, because there
  // the alternative is interpolating an unknown string into SQL; here the
  // alternative is a rule that silently fires on everything.
  if (!field) return false;

  return compare(field, node, row, options);
}

function compare(
  field: FieldDefinition,
  node: Extract<FilterNode, { kind: 'comparison' }>,
  row: EvaluableRow,
  options: EvaluateOptions,
): boolean {
  const actual = row[field.name];
  const isArray = field.type === 'uuid_array';

  switch (node.operator) {
    case 'is_empty':
      return isArray ? !Array.isArray(actual) || actual.length === 0 : isNullish(actual);

    case 'is_not_empty':
      return isArray ? Array.isArray(actual) && actual.length > 0 : !isNullish(actual);

    case 'in':
    case 'not_in': {
      const wanted = (node.value as readonly FilterValue[]).map((entry) =>
        resolve(entry, field, options),
      );
      if (wanted.length === 0) return node.operator === 'not_in';

      const matched = isArray
        ? Array.isArray(actual) && actual.some((entry) => wanted.includes(entry as FilterValue))
        : wanted.includes(actual as FilterValue);

      return node.operator === 'in' ? matched : !matched;
    }

    case 'contains': {
      if (isNullish(actual) || typeof actual !== 'string') return false;
      const needle = String(resolve(node.value as FilterValue, field, options));
      // ILIKE is case-insensitive; `includes` is not. This is one of the three
      // places SQL and JavaScript disagree by default.
      return actual.toLowerCase().includes(needle.toLowerCase());
    }

    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const expected = resolve(node.value as FilterValue, field, options);

      // Mirrors the compiler turning `= NULL` into `IS NULL`.
      if (expected === null) {
        return node.operator === 'neq' ? !isNullish(actual) : isNullish(actual);
      }

      /* SQL's three-valued logic: any comparison against NULL is UNKNOWN, which
         does not match. `neq` included — a row with a null title does NOT
         satisfy `title != 'x'` in Postgres, and a JavaScript `!==` would say it
         does. */
      if (isNullish(actual)) return false;

      const order = orderOf(field, actual, expected);
      if (order === undefined) return false;

      switch (node.operator) {
        case 'eq':
          return order === 0;
        case 'neq':
          return order !== 0;
        case 'lt':
          return order < 0;
        case 'lte':
          return order <= 0;
        case 'gt':
          return order > 0;
        case 'gte':
          return order >= 0;
        default:
          return false;
      }
    }

    default:
      /* Unreachable while OPERATORS and this switch agree. Returning false
         rather than throwing: an automation rule with an operator this build
         does not know must not fire, and must not take the worker down. */
      return false;
  }
}

/**
 * Compares two values the way Postgres would, returning -1, 0, 1, or undefined.
 *
 * Dates are the case worth care: comparing ISO strings as text disagrees with
 * Postgres the moment one value carries an offset and the other ends in `Z`,
 * because `2026-07-29T00:00:00+01:00` sorts after `2026-07-29T00:00:00Z` as
 * text and before it as an instant.
 */
function orderOf(
  field: FieldDefinition,
  actual: unknown,
  expected: FilterValue,
): number | undefined {
  if (field.type === 'date') {
    const left = toInstant(actual);
    const right = toInstant(expected);
    if (left === undefined || right === undefined) return undefined;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  if (field.type === 'number') {
    if (typeof actual !== 'number' || typeof expected !== 'number') return undefined;
    return actual === expected ? 0 : actual < expected ? -1 : 1;
  }

  if (field.type === 'boolean') {
    if (typeof actual !== 'boolean' || typeof expected !== 'boolean') return undefined;
    return actual === expected ? 0 : actual ? 1 : -1;
  }

  const left = String(actual);
  const right = String(expected);
  return left === right ? 0 : left < right ? -1 : 1;
}

function toInstant(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Null and undefined are both SQL NULL as far as a filter is concerned. */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function resolve(
  value: FilterValue,
  field: FieldDefinition,
  options: EvaluateOptions,
): FilterValue {
  if (value !== ME) return value;
  if (field.acceptsMe !== true || options.viewerId === undefined) return null;
  return options.viewerId;
}
