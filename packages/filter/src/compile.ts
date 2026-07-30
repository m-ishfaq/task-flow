import { ME, type FilterNode, type FilterValue, type Operator } from './ast.js';
import { findField, type FieldDefinition, type Resource } from './fields.js';
import { validate } from './validate.js';

/**
 * Compiling a filter tree to parameterized SQL (PLAN.md §10.2).
 *
 * The last step of `tokenize -> parse -> validate -> COMPILE TO A
 * PARAMETERIZED QUERY`, and the one where a mistake is an injection rather than
 * a bad error message.
 *
 * Three rules, and the whole file is an application of them:
 *
 *   1. FIELD NAMES come from `fields.ts` and are interpolated verbatim. Safe
 *      only because those strings are literals in a source file that no input
 *      can reach. A field the compiler cannot find is an ERROR, never a
 *      fallback — see `compile` below.
 *   2. OPERATORS map to fixed fragments through a switch. There is no path from
 *      a caller's string to an operator token.
 *   3. VALUES are always placeholders. `$1`, `$2`, never interpolation, with no
 *      exception for numbers or booleans — an exception is what makes the next
 *      person believe there might be others.
 *
 * ## Why it emits placeholders and not a Drizzle expression
 *
 * The result is `{ sql, params }`, which the caller hands to the tenant-scoped
 * client. Returning a Drizzle `SQL` object would mean importing @taskflow/db
 * here, and this package is also consumed by the Phase 10 evaluator that runs
 * in a worker with no database at all.
 */

export interface CompiledFilter {
  /** A SQL boolean expression with `$n` placeholders. Never contains input. */
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface CompileOptions {
  /** Substituted for `@me`. Required when the tree mentions it. */
  readonly viewerId?: string;
  /** Placeholder number to start from, when the caller already has parameters. */
  readonly startIndex?: number;
}

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterCompileError';
  }
}

/**
 * Compiles a validated tree.
 *
 * Re-runs `validate` rather than trusting the caller. That is not paranoia
 * about a hostile caller — it is about a FORGETFUL one: the compiler is the
 * only thing standing between a filter and the database, and "the caller
 * validated it" is an assumption that holds until someone adds a second call
 * site. Validation is a pure tree walk over at most 200 nodes.
 */
export function compile(
  resource: Resource,
  node: FilterNode,
  options: CompileOptions = {},
): CompiledFilter {
  const result = validate(resource, node);
  if (!result.ok) {
    throw new FilterCompileError(
      `Refusing to compile an invalid filter: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }

  const params: unknown[] = [];
  const offset = options.startIndex ?? 1;

  const placeholder = (value: unknown): string => {
    params.push(value);
    return `$${String(params.length + offset - 1)}`;
  };

  const sql = emit(resource, node, placeholder, options);
  return { sql, params };
}

function emit(
  resource: Resource,
  node: FilterNode,
  placeholder: (value: unknown) => string,
  options: CompileOptions,
): string {
  if (node.kind === 'group') {
    if (node.children.length === 0) {
      /* An empty group is "no constraint". `TRUE` for AND and FALSE for OR are
         the identity elements, so a nested empty group cannot change what its
         parent means. */
      return node.combinator === 'and' ? 'TRUE' : 'FALSE';
    }

    const parts = node.children.map((child) => emit(resource, child, placeholder, options));
    // Always parenthesized. Without it, `a AND b OR c` regroups by precedence
    // into something the user did not build.
    return `(${parts.join(node.combinator === 'and' ? ' AND ' : ' OR ')})`;
  }

  if (node.kind === 'not') {
    /* `NOT (x)` is not the same as `x = false` when x is NULL, and a card with
       no due date must not match `not (due < today)` by accident. Wrapping in
       COALESCE makes the three-valued logic explicit: an unknown is not a
       match, so its negation is. */
    return `(NOT COALESCE(${emit(resource, node.child, placeholder, options)}, FALSE))`;
  }

  const field = findField(resource, node.field);
  /* Unreachable after validate() — and it stays here anyway. If validation is
     ever skipped or a field set is edited between the two calls, this is the
     difference between an exception and interpolating a caller's string into
     SQL. */
  if (!field) throw new FilterCompileError(`Unknown field "${node.field}".`);

  return emitComparison(field, node.operator, node.value, placeholder, options);
}

function emitComparison(
  field: FieldDefinition,
  operator: Operator,
  value: FilterValue | readonly FilterValue[] | undefined,
  placeholder: (value: unknown) => string,
  options: CompileOptions,
): string {
  const column = field.sql;

  // Array fields are asked about membership, never equality.
  const isArray = field.type === 'uuid_array';

  switch (operator) {
    case 'is_empty':
      return isArray ? `(${column} IS NULL OR cardinality(${column}) = 0)` : `${column} IS NULL`;

    case 'is_not_empty':
      return isArray
        ? `(${column} IS NOT NULL AND cardinality(${column}) > 0)`
        : `${column} IS NOT NULL`;

    case 'in':
    case 'not_in': {
      const values = (value as readonly FilterValue[]).map((entry) =>
        resolve(entry, field, options),
      );
      if (values.length === 0) {
        // `IN ()` is a syntax error, and an empty list is a real state in a UI
        // where someone opened a picker and chose nothing.
        return operator === 'in' ? 'FALSE' : 'TRUE';
      }

      const list = values.map(placeholder).join(', ');
      if (isArray) {
        /* Overlap, not containment: "assignee in (a, b)" means "assigned to a
           OR b", which is what a person picking two names intends. `@>` would
           mean "assigned to both". */
        const expression = `${column} && ARRAY[${list}]::uuid[]`;
        return operator === 'in' ? `(${expression})` : `(NOT COALESCE(${expression}, FALSE))`;
      }
      return operator === 'in' ? `${column} IN (${list})` : `${column} NOT IN (${list})`;
    }

    case 'contains': {
      /* Case-insensitive substring. The value is a PARAMETER — the wildcards are
         added around the placeholder, not into it, so a user typing `%` matches
         a literal percent sign rather than everything. */
      const escaped = escapeLike(String(resolve(value as FilterValue, field, options)));
      return `${column} ILIKE ${placeholder(`%${escaped}%`)} ESCAPE '\\'`;
    }

    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const resolved = resolve(value as FilterValue, field, options);

      // `= NULL` is never true. A user asking for "due = nothing" means IS NULL.
      if (resolved === null) {
        return operator === 'neq' ? `${column} IS NOT NULL` : `${column} IS NULL`;
      }

      const token = COMPARISON_TOKENS[operator];

      const cast = field.type === 'uuid' ? '::uuid' : field.type === 'date' ? '::timestamptz' : '';
      return `${column} ${token} ${placeholder(resolved)}${cast}`;
    }

    default:
      /* Unreachable while OPERATORS and this switch agree. Exhaustiveness is
         checked by lint, so a new operator added without a SQL form is a build
         failure rather than a filter that silently matches nothing. */
      throw new FilterCompileError(`Operator "${String(operator)}" has no SQL form.`);
  }
}

/**
 * Operator to SQL token.
 *
 * A lookup table rather than string building, so there is no expression
 * anywhere that turns a caller's value into an operator.
 */
type ComparisonOperator = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';

/* A TOTAL record over the six ordering operators, not a Partial over all of
   them. Partial would type every lookup as possibly-undefined and invite a
   fallback at the call site — and a fallback here would mean an unrecognized
   operator silently compiling to something. Adding a seventh ordering operator
   is a type error until it is given a token. */
const COMPARISON_TOKENS: Readonly<Record<ComparisonOperator, string>> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Substitutes `@me`, leaving every other value untouched. */
function resolve(value: FilterValue, field: FieldDefinition, options: CompileOptions): FilterValue {
  if (value !== ME) return value;

  if (field.acceptsMe !== true) {
    throw new FilterCompileError(`"${ME}" has no meaning for field "${field.name}".`);
  }
  if (options.viewerId === undefined) {
    /* Refusing beats defaulting. A filter mentioning `@me` compiled without a
       viewer would silently become "assigned to nobody" and quietly return the
       wrong rows to whoever opened it. */
    throw new FilterCompileError(`This filter uses "${ME}" but no viewer was supplied.`);
  }
  return options.viewerId;
}

/**
 * Escapes LIKE metacharacters in a value.
 *
 * Not a security control — the value is parameterized either way — but a
 * correctness one: a user searching for `50%` means the literal string, and
 * without this it matches everything beginning `50`.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
