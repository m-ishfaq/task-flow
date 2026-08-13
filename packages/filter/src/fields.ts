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
   * The SQL expression this field compiles to, or `null` for a field that has
   * no SQL form at all.
   *
   * A literal written in this file. It is interpolated into the generated SQL
   * without escaping — which is safe ONLY because it is never derived from
   * input, and is why this file is short and boring on purpose.
   *
   * `null` is the connector set (§7.8b): those fields describe an event
   * payload the worker holds in memory, and there is no table to compile them
   * against. The compiler THROWS on one rather than skipping it — a field that
   * silently disappeared from a WHERE clause would widen the filter, which is
   * the direction that returns rows the author did not ask for.
   */
  readonly sql: string | null;
  /**
   * Operators this field supports, overriding `OPERATORS_BY_TYPE[type]`.
   *
   * The table is keyed by TYPE because that is nearly always the right axis —
   * what you can ask of a date follows from it being a date. The override
   * exists for a field whose type is right but whose vocabulary should be
   * narrower or wider than its type's, and it is read through `operatorsFor`
   * so the validator and the builder's operator menu cannot disagree about
   * which one applies.
   */
  readonly operators?: readonly Operator[];
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
  /* `is_empty`/`is_not_empty` matter here specifically for `priority`, which
     is NULLABLE (§5.1 of the phase plan — "no priority" is a real, common
     state). Both compile and evaluate generically as a null check for any
     non-array type, so adding them costs nothing for `status`, which never
     stores null once a card has been through `cards.create`'s default. */
  enum: ['eq', 'neq', 'in', 'not_in', 'is_empty', 'is_not_empty'],
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
  /* A real FK, unlike `label` — one status per card, not a set — so `uuid`
     is the right type and there is no aggregate subquery to get wrong. */
  { name: 'status', type: 'uuid', sql: 'work.cards.status_id' },
  /* Closed list, not free text — matches the CHECK constraint on the column.
     `options` is what makes `checkValue` in validate.ts reject anything a
     client invents, the same closed-world reasoning as a custom field's
     `select` type. */
  {
    name: 'priority',
    type: 'enum',
    sql: 'work.cards.priority',
    options: ['urgent', 'high', 'normal', 'low'],
  },
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

/**
 * Cross-product search fields (Phase 8, ai/phase-8-search.md §2.1).
 *
 * These map onto `search.documents`' columns so the EXISTING compiler needs no
 * changes — the projection is shaped to make the field whitelist true, not the
 * other way around. `text` is the free-text target: bare terms in TQL desugar
 * to `text contains <term>` (tql/parse.ts), and the search route orders by
 * trigram similarity over the same column. `type` is the one field no single
 * resource has, which is why cross-product search needed its own set.
 *
 * `archived` mirrors the projection's normalized boolean (cards archive via
 * `archived_at`, messages via `deleted_at`, pages via `archived_at`); the
 * indexer flattens all three into one column so one filter means the same
 * thing across every type.
 */
const SEARCH_FIELDS: readonly FieldDefinition[] = [
  {
    name: 'type',
    type: 'enum',
    sql: 'search.documents.entity_type',
    /* Mirrors migration 0045's `documents_entity_type_check`, widened by 0046.
       These two lists are the same closed set said twice — in SQL, where a
       wrong value is refused at write, and here, where `type = trascript`
       becomes a positioned parse error instead of a query that silently
       matches nothing. */
    options: ['card', 'message', 'page', 'comment', 'transcript'],
  },
  { name: 'title', type: 'text', sql: 'search.documents.title' },
  /* `text` compiles to the TITLE||BODY concatenation, not `body` alone —
     migration 0045's two GIN indexes are built over exactly this expression,
     and a page with no body must still be findable by its title. The trade:
     `text IS EMPTY` is meaningless here (coalesce is never NULL), which is
     fine — nobody filters a search on empty free text. */
  {
    name: 'text',
    type: 'text',
    sql: "coalesce(search.documents.title, '') || ' ' || coalesce(search.documents.body, '')",
  },
  { name: 'author', type: 'uuid', sql: 'search.documents.author_id', acceptsMe: true },
  { name: 'updated', type: 'date', sql: 'search.documents.updated_at' },
  { name: 'created', type: 'date', sql: 'search.documents.created_at' },
  { name: 'archived', type: 'boolean', sql: 'search.documents.archived' },
];

const SEARCH_FIELD_MAP: ReadonlyMap<string, FieldDefinition> = new Map(
  SEARCH_FIELDS.map((field) => [field.name, field]),
);

/**
 * Connector-event fields (ai/phase-10-automation.md §7.8b).
 *
 * The third field set, and the first one with NO SQL behind it. An automation
 * rule keyed on `integration.slack_event` / `integration.github_event` is
 * evaluated against the event payload the worker already holds, never against
 * a table — so every entry here has `sql: null` and the compiler refuses the
 * whole resource (see `compile`).
 *
 * ## Why exactly two fields
 *
 * The provider's own body stays `unknown` (§7.5): its shape belongs to GitHub
 * and Slack, and a field set over it would be this repo asserting a schema it
 * does not own and cannot keep current. These two are the WRAPPER — the part
 * the inbound routes build and validate themselves — so they are the part that
 * can be promised to a rule author.
 *
 * ## The gap this closes
 *
 * Until this existed, a rule on a connector event could carry no condition at
 * all: `evaluableRowFor` re-read the trigger's CARD, a connector event has
 * none, and the engine recorded `trigger_not_evaluable` and refused. So the
 * only rule that could run was one with no condition — which fires on EVERY
 * event type from EVERY connected repo. A repo with GitHub Actions emits
 * `workflow_job` continuously, so the first rule anybody wrote was immediately
 * noise.
 *
 * ## Operators
 *
 * Overridden per field rather than by widening `text`, which `title` and
 * `description` also use. "Is one of these event types" is the natural way to
 * write a connector rule (`provider_event in ["push", "pull_request"]`), and
 * `in`/`not_in` on a scalar text column is already correct in BOTH backends —
 * but adding it to the type table would silently change the card and search
 * vocabularies too, and a widening nobody asked for is how a closed set stops
 * being closed.
 */
const CONNECTOR_OPERATORS: readonly Operator[] = ['eq', 'neq', 'in', 'not_in', 'contains'];

const CONNECTOR_FIELDS: readonly FieldDefinition[] = [
  /* Slack's `event.type` (or the top-level type), or GitHub's X-GitHub-Event
     header — normalized to one name because a rule author is asking the same
     question of both. Free text, not an enum: the legal values are the
     provider's to add to, and a closed list here would refuse a brand-new
     GitHub event type as if the author had made it up. */
  { name: 'provider_event', type: 'text', sql: null, operators: CONNECTOR_OPERATORS },
  /* Slack team_id, or GitHub `repository.full_name` — WHICH workspace or repo.
     This is what narrows a rule to one repository when an org has connected
     several, and it is why the wrapper carries it separately from the body. */
  { name: 'provider_scope', type: 'text', sql: null, operators: CONNECTOR_OPERATORS },
];

const CONNECTOR_FIELD_MAP: ReadonlyMap<string, FieldDefinition> = new Map(
  CONNECTOR_FIELDS.map((field) => [field.name, field]),
);

/**
 * Resources that can be filtered. `card` since Phase 3, `search` since Phase 8,
 * `connector` since Phase 10 Wave 4 (§7.8b).
 *
 * The three sets are CLOSED and do NOT overlap, which is deliberate and is also
 * a trap worth knowing: an example written against the wrong set validates in a
 * person's head and is refused by `validate()`. Check one before writing it
 * anywhere a person will read it.
 */
export const FIELD_SETS = {
  card: CARD_FIELD_MAP,
  search: SEARCH_FIELD_MAP,
  connector: CONNECTOR_FIELD_MAP,
} as const;

export type Resource = keyof typeof FIELD_SETS;

/**
 * The triggers whose conditions are evaluated against the connector set.
 *
 * **Which field set a trigger uses is a property OF THE TRIGGER**, never a flag
 * on the rule — a rule saved under one reading and evaluated under another
 * after an edit is a rule that changes meaning without anybody touching it.
 * This table is that property, in one place, because four callers need the same
 * answer: the API's save-time validation, its list projection, the worker's
 * stored-condition parse, and the builder's field picker.
 *
 * It lives here rather than in `@taskflow/events` because `apps/web` does not
 * depend on that package, and three copies of a mapping is exactly the drift
 * this package exists to prevent. The cost is that this file knows two event
 * names; the alternative cost was that they disagreed.
 */
const CONNECTOR_TRIGGERS: ReadonlySet<string> = new Set([
  'integration.slack_event',
  'integration.github_event',
]);

/** The field set a rule on `triggerEvent` is validated and evaluated against. */
export function resourceForTrigger(triggerEvent: string): Resource {
  return CONNECTOR_TRIGGERS.has(triggerEvent) ? 'connector' : 'card';
}

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

/**
 * The operators a field supports — its own list, or its type's.
 *
 * Every caller that offers or checks an operator goes through this, so the
 * builder's menu and the validator's refusal are computed from one expression.
 * Reading `OPERATORS_BY_TYPE[field.type]` directly is the bug: it ignores a
 * per-field override, and the failure is a chip the builder renders as valid
 * and the server refuses on save.
 */
export function operatorsFor(field: FieldDefinition): readonly Operator[] {
  return field.operators ?? OPERATORS_BY_TYPE[field.type];
}

/** True when `operator` makes sense for `field`. */
export function supportsOperator(field: FieldDefinition, operator: Operator): boolean {
  return operatorsFor(field).includes(operator);
}
