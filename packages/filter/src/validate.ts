import { LIST_OPERATORS, ME, NULLARY_OPERATORS, type FilterNode, type FilterValue } from './ast.js';
import { findField, supportsOperator, type FieldDefinition, type Resource } from './fields.js';
import { isSymbolicDate } from './tql/relative-date.js';

/**
 * Validating a filter tree against a resource's fields (PLAN.md §10.2).
 *
 * The pipeline is `tokenize -> parse to AST -> VALIDATE FIELDS AND OPERATORS
 * AGAINST A WHITELIST -> compile to a parameterized query`. This is the third
 * step, and it is the one that makes the fourth safe.
 *
 * Separate from the Zod schema in ast.ts because that schema checks SHAPE and
 * cannot check MEANING: it does not know whether a tree is filtering cards or
 * messages, so it cannot know that `assignee` is a field and `assignedTo` is
 * not, or that `contains` is meaningless on a date.
 *
 * Returns errors rather than throwing, because the visual builder wants to show
 * all of them at once — a filter with three bad chips should light up three
 * chips, not the first one.
 */

export interface FilterError {
  /** Path to the offending node, as indices from the root. For the UI. */
  readonly path: readonly number[];
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly FilterError[];
}

export function validate(resource: Resource, node: FilterNode): ValidationResult {
  const errors: FilterError[] = [];
  walk(resource, node, [], errors);
  return { ok: errors.length === 0, errors };
}

function walk(
  resource: Resource,
  node: FilterNode,
  path: readonly number[],
  errors: FilterError[],
): void {
  if (node.kind === 'group') {
    for (const [index, child] of node.children.entries()) {
      walk(resource, child, [...path, index], errors);
    }
    return;
  }

  if (node.kind === 'not') {
    walk(resource, node.child, [...path, 0], errors);
    return;
  }

  const field = findField(resource, node.field);
  if (!field) {
    /* The message names the field the caller sent. That is deliberate and safe:
       they typed it, so it discloses nothing — and "unknown field" with no name
       is the most annoying error message a query builder can produce. */
    errors.push({ path, message: `Unknown field "${node.field}".` });
    return;
  }

  if (!supportsOperator(field, node.operator)) {
    errors.push({
      path,
      message: `Operator "${node.operator}" cannot be used with ${field.type} field "${field.name}".`,
    });
    return;
  }

  if (NULLARY_OPERATORS.includes(node.operator)) return;

  const values = LIST_OPERATORS.includes(node.operator)
    ? (node.value as readonly FilterValue[])
    : [node.value as FilterValue];

  for (const value of values) {
    const problem = checkValue(field, value);
    if (problem) errors.push({ path, message: problem });
  }
}

/**
 * Checks one value against its field's type.
 *
 * Strict rather than coercive, for the same reason as custom field values: a
 * filter that silently reinterprets `"5"` as `5` is a filter whose meaning
 * depends on how the client serialized it, and Phase 8's text parser would then
 * have to reproduce the same coercions to agree with the visual builder.
 */
function checkValue(field: FieldDefinition, value: FilterValue): string | null {
  // Null is legal everywhere and means "compare against nothing" — which the
  // compiler turns into an IS NULL rather than `= NULL`, the classic silent
  // always-false comparison.
  if (value === null) return null;

  /* `@me` is checked BEFORE the type switch, for every field.
     Doing it only in the uuid branch let `title = @me` validate cleanly and
     then throw in the compiler — a chip the builder renders as valid and that
     explodes when applied. Validation and compilation must reject the same
     trees, or the UI cannot tell a user what is wrong before they run it. */
  if (value === ME) {
    return field.acceptsMe === true
      ? null
      : `Field "${field.name}" is not a user field, so "${ME}" has no meaning for it.`;
  }

  switch (field.type) {
    case 'text':
      return typeof value === 'string' ? null : `Field "${field.name}" expects text.`;

    case 'number':
      return typeof value === 'number' ? null : `Field "${field.name}" expects a number.`;

    case 'boolean':
      return typeof value === 'boolean' ? null : `Field "${field.name}" expects true or false.`;

    case 'date': {
      if (typeof value !== 'string') return `Field "${field.name}" expects an ISO date.`;
      /* Symbolic dates (`-7d`, `@today`) are a closed literal set from TQL
         (tql/relative-date.ts). They pass here so a saved query can be typed
         in TQL and re-parsed by the builder without tripping an ISO check;
         compile/evaluate resolve them against an injectable clock. */
      if (isSymbolicDate(value)) return null;
      return Number.isNaN(Date.parse(value)) ? `Field "${field.name}" expects an ISO date.` : null;
    }

    case 'uuid':
    case 'uuid_array': {
      /* `@me` has already been accepted above where it is legal — it stays
         symbolic until compile time, because a client substituting its own id
         would make a SHARED saved filter mean "assigned to whoever saved it". */
      if (typeof value !== 'string') return `Field "${field.name}" expects an id.`;
      return UUID.test(value) ? null : `Field "${field.name}" expects an id.`;
    }

    case 'enum': {
      if (typeof value !== 'string') return `Field "${field.name}" expects one of its options.`;
      return field.options?.includes(value) === true
        ? null
        : `"${value}" is not a valid value for "${field.name}".`;
    }

    default:
      /* Unreachable while FieldType and this switch agree; reachable during a
         rolling deploy from a build that knows a type this one does not.
         Refusing is right — compiling a field whose type is unknown means
         guessing how to compare it. */
      return `Field "${field.name}" has a type this version cannot filter on.`;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
