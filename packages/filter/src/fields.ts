import type { Operator } from './ast.js';

/**
 * The field whitelist (PLAN.md §10.2).
 *
 * **This file is the security control.** §10.2: "The whitelist is the security
 * control — no user string ever reaches the database as a field name or
 * operator."
 *
 * A `FieldDefinition` binds a name a user can type to:
 *   - a SQL COLUMN EXPRESSION, written here and never derived from input
 *   - a type, which decides which operators are legal and how values are read
 *   - the operators that make sense for it
 *
 * The compiler looks a field up in this map and uses `sql` verbatim. There is no
 * path by which an unlisted name produces SQL, because an unlisted name fails
 * validation before the compiler runs — and the compiler additionally refuses a
 * field it cannot find, so a validation step that was accidentally skipped
 * produces an error rather than an injection.
 *
 * ## Adding a field
 *
 * Two places: here, and the evaluator's value reader. The compiler needs no
 * change. A field with a SQL expression but no reader is a filter that works on
 * a board and silently never matches in an automation rule, which is exactly
 * the drift the shared AST exists to prevent — so `fields.test.ts` asserts every
 * entry has both.
 */

export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'uuid' | 'uuid_array' | 'enum';

export interface FieldDefinition {
  /** The name a client uses. */
  readonly name: string;
  readonly type: FieldType;
  /**
   * The SQL expression this field compiles to.
   *
   * A literal written in this file. It is interpolated into the generated SQL
   * without escaping — which is safe ONLY because it is never derived from
   * input, and is why this file is short and boring on purpose.
   */
  readonly sql: string;
  /** Legal values, for `enum` fields. The compiler still parameterizes them. */
  readonly options?: readonly string[];
  /**
   * True when `@me` may be substituted.
   *
   * Only user-valued fields. Allowing it elsewhere would make `title = @me`
   * compile to a comparison against a UUID, which is not an error anyone would
   * understand.
   */
  readonly acceptsMe?: boolean;
}

/** Operators each type supports. The pairing the validator enforces. */
export const OPERATORS_BY_TYPE: Readonly<Record<FieldType, readonly Operator[]>> = {
  text: ['eq', 'neq', 'contains', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_empty', 'is_not_empty'],
  date: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'is_empty', 'is_not_empty'],
  boolean: ['eq', 'neq'],
  uuid: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  /* Arrays get containment rather than equality: "is one of the assignees" is
     the question people mean, and `=` on an array column would compare the
     whole set. */
  uuid_array: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  enum: ['eq', 'neq', 'in', 'not_in'],
};

/**
 * Card fields.
 *
 * Every expression is FULLY QUALIFIED as `work.cards.<column>`, matching what
 * Drizzle emits for the same table. A bare column would work until the first
 * join introduced a second `title`, and Postgres reports that ambiguity at
 * query time — in production, on a filter nobody tested. A short alias would be
 * worse: it would have to match an alias the query builder chose.
 */
const CARD_FIELDS: readonly FieldDefinition[] = [
  { name: 'title', type: 'text', sql: 'work.cards.title' },
  /* The flattened description, not the JSON. Searching inside jsonb would mean
     the filter depended on the document schema, which is the coupling
     `description_text` exists to remove. */
  { name: 'description', type: 'text', sql: 'work.cards.description_text' },
  { name: 'list', type: 'uuid', sql: 'work.cards.list_id' },
  { name: 'board', type: 'uuid', sql: 'work.cards.board_id' },
  { name: 'project', type: 'uuid', sql: 'work.cards.project_id' },
  { name: 'number', type: 'number', sql: 'work.cards.number' },
  { name: 'assignee', type: 'uuid_array', sql: 'work.cards.assignee_ids', acceptsMe: true },
  { name: 'creator', type: 'uuid', sql: 'work.cards.created_by', acceptsMe: true },
  { name: 'due', type: 'date', sql: 'work.cards.due_date' },
  { name: 'start', type: 'date', sql: 'work.cards.start_date' },
  { name: 'created', type: 'date', sql: 'work.cards.created_at' },
  { name: 'updated', type: 'date', sql: 'work.cards.updated_at' },
  { name: 'comments', type: 'number', sql: 'work.cards.comment_count' },
  { name: 'checklistDone', type: 'number', sql: 'work.cards.checklist_done' },
  { name: 'checklistTotal', type: 'number', sql: 'work.cards.checklist_total' },
  {
    name: 'archived',
    type: 'boolean',
    /* A computed boolean rather than a timestamp column. "archived = true" is
       what a user means; making them write "archivedAt is not empty" would be
       exposing the storage decision as product vocabulary. */
    sql: '(work.cards.archived_at IS NOT NULL)',
  },
  /**
   * Labels, via a correlated subquery that aggregates them into an array.
   *
   * The alternative — a join — would multiply card rows by their labels and
   * make every other predicate operate on duplicates. Aggregating keeps the
   * result one row per card, which is what every caller expects.
   *
   * ## Why the type is `uuid_array` and not `uuid`
   *
   * It was `uuid` until a parity test was written for it, and both backends were
   * wrong in DIFFERENT directions — which is the specific failure this package
   * exists to prevent, reached because the field had no test at all.
   *
   * The expression evaluates to `uuid[]`. Declared as `uuid`, the compiler
   * emitted `(SELECT array_agg(...)) = $1::uuid`, and Postgres has no
   * `uuid[] = uuid` operator, so every label filter was a 500. The evaluator
   * meanwhile took the scalar path, compared an array against a uuid with
   * `includes`, and quietly matched nothing — so a Phase 10 rule filtering by
   * label would never fire while the board view errored.
   *
   * As `uuid_array` both take the array path: `&&` overlap in SQL, `some()` in
   * JavaScript, and `is_empty` covers the NULL that `array_agg` returns for a
   * card with no labels. It is also the right product meaning — "has one of
   * these labels", not "its label set equals this one".
   */
  {
    name: 'label',
    type: 'uuid_array',
    sql: '(SELECT array_agg(cl.label_id) FROM work.card_labels cl WHERE cl.card_id = work.cards.id)',
  },
];

const CARD_FIELD_MAP: ReadonlyMap<string, FieldDefinition> = new Map(
  CARD_FIELDS.map((field) => [field.name, field]),
);

/** Resources that can be filtered. One entry today; Phase 8 adds more. */
export const FIELD_SETS = {
  card: CARD_FIELD_MAP,
} as const;

export type Resource = keyof typeof FIELD_SETS;

/**
 * Looks a field up, or returns undefined.
 *
 * A `Map` keyed by string rather than a `Record`, so the lookup honestly
 * returns undefined for a name the type system believes exists — the value came
 * from a request, and a `Record` lookup would type as `FieldDefinition` while
 * being `undefined` at runtime.
 */
export function findField(resource: Resource, name: string): FieldDefinition | undefined {
  return FIELD_SETS[resource].get(name);
}

/** Every filterable field, for the visual builder's field picker. */
export function fieldsOf(resource: Resource): readonly FieldDefinition[] {
  return [...FIELD_SETS[resource].values()];
}

/** True when `operator` makes sense for `type`. */
export function supportsOperator(type: FieldType, operator: Operator): boolean {
  return OPERATORS_BY_TYPE[type].includes(operator);
}
