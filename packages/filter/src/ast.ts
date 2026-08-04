import { z } from 'zod';

/**
 * The filter AST (PLAN.md §10.2).
 *
 * ## Why this exists in Phase 3 and the parser does not
 *
 * §10.2 splits TQL deliberately:
 *
 *   Phase 3   visual filter builder ──► AST ──► SQL compiler
 *   Phase 10  automation conditions ──► AST ──► in-memory evaluator
 *   Phase 8   TQL text ──► parser ──► AST
 *
 * The AST plus its compiler are needed NOW, for board and table filtering. The
 * tokenizer is only needed when users type queries. Building ILIKE search now
 * and TQL later would mean writing filtering twice and throwing one away.
 *
 * ## The whitelist IS the security control
 *
 * "No user string ever reaches the database as a field name or operator."
 * That sentence is the whole design. A field is a member of a closed set
 * (`FIELDS` in fields.ts), an operator is a member of a closed set, and the
 * compiler maps each to a fixed SQL fragment. VALUES are parameterized.
 *
 * The consequence worth stating: this AST cannot express a query the compiler
 * does not already know how to write. That is not a limitation to work around
 * — it is why a filter arriving from a browser can be compiled to SQL at all.
 */

/**
 * Comparison operators.
 *
 * Closed, and small on purpose. Every entry needs a SQL fragment in the
 * compiler AND an implementation in the evaluator, and the two must agree —
 * an operator that means one thing in Postgres and another in JavaScript makes
 * a Phase 10 automation fire on cards a Phase 3 filter would not have shown.
 */
export const OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'not_in',
  'contains',
  'is_empty',
  'is_not_empty',
] as const;

export type Operator = (typeof OPERATORS)[number];

/**
 * Operators that take no value.
 *
 * Split out because "is empty" with a value and "equals" without one are both
 * malformed, and a schema that accepted either would push the check into the
 * compiler — where getting it wrong produces SQL with a dangling comparison.
 */
export const NULLARY_OPERATORS: readonly Operator[] = ['is_empty', 'is_not_empty'];

/** Operators taking a LIST rather than a scalar. */
export const LIST_OPERATORS: readonly Operator[] = ['in', 'not_in'];

/**
 * A literal value.
 *
 * Deliberately narrow: string, number, boolean, or null. No objects, no nested
 * arrays, no dates-as-Date. A date arrives as an ISO string and is compared as
 * one, because the alternative is a value whose meaning depends on which
 * process deserialized it.
 */
export const FilterValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type FilterValue = z.infer<typeof FilterValue>;

/**
 * A special value meaning "whoever is running this query".
 *
 * `assignee = me` is the single most-used filter in any tracker, and the naive
 * implementation — the client substituting its own user id — breaks the moment
 * a saved filter is shared: it silently becomes "assigned to the person who
 * saved it". Keeping `me` symbolic until compile time means a shared filter
 * means the same thing to everyone who opens it.
 */
export const ME = '@me' as const;

export interface ComparisonNode {
  readonly kind: 'comparison';
  readonly field: string;
  readonly operator: Operator;
  /**
   * Absent for `is_empty` and `is_not_empty`, present for everything else — a
   * pairing the schema below enforces, because an operator with a spare value
   * and one missing its own are both malformed in ways the compiler would turn
   * into a dangling comparison.
   *
   * `| undefined` is explicit because `exactOptionalPropertyTypes` otherwise
   * makes this incompatible with what Zod infers for an `.optional()` field.
   */
  readonly value?: FilterValue | readonly FilterValue[] | undefined;
}

export interface GroupNode {
  readonly kind: 'group';
  readonly combinator: 'and' | 'or';
  readonly children: readonly FilterNode[];
}

export interface NotNode {
  readonly kind: 'not';
  readonly child: FilterNode;
}

export type FilterNode = ComparisonNode | GroupNode | NotNode;

/**
 * Depth limit.
 *
 * A filter is built by dragging chips in a UI, so twelve levels is already far
 * past anything a person constructs. The limit exists because both the compiler
 * and the evaluator recurse, and an unbounded tree from an API client is a
 * stack overflow in whichever runs first.
 */
export const MAX_DEPTH = 12;

/** Total node budget, so a wide-but-shallow tree cannot do the same job. */
export const MAX_NODES = 200;

/** Largest `in` list. Beyond this the query stops being a filter. */
export const MAX_LIST_LENGTH = 200;

const ComparisonSchema: z.ZodType<ComparisonNode> = z
  .object({
    kind: z.literal('comparison'),
    /* Shape only — that this NAMES a real field is checked by `validate`,
       which knows the field set for the resource being queried. Two steps
       because the schema cannot know whether it is filtering cards or
       messages. */
    field: z.string().min(1).max(80),
    operator: z.enum(OPERATORS),
    value: z.union([FilterValue, z.array(FilterValue).max(MAX_LIST_LENGTH)]).optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    const takesNoValue = NULLARY_OPERATORS.includes(node.operator);
    const takesList = LIST_OPERATORS.includes(node.operator);

    if (takesNoValue && node.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${node.operator}" takes no value.`,
        path: ['value'],
      });
      return;
    }
    if (!takesNoValue && node.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${node.operator}" requires a value.`,
        path: ['value'],
      });
      return;
    }

    if (takesList && !Array.isArray(node.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${node.operator}" requires a list.`,
        path: ['value'],
      });
    }
    if (!takesList && Array.isArray(node.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator "${node.operator}" does not take a list.`,
        path: ['value'],
      });
    }
  });

const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    ComparisonSchema,
    z
      .object({
        kind: z.literal('group'),
        combinator: z.enum(['and', 'or']),
        /* An empty group is legal and means "no constraint". Rejecting it would
           make a UI that starts with an empty filter panel have to special-case
           its own initial state. */
        children: z.array(FilterNodeSchema).max(MAX_NODES),
      })
      .strict(),
    z.object({ kind: z.literal('not'), child: FilterNodeSchema }).strict(),
  ]),
);

/**
 * The wire schema for a filter tree.
 *
 * Structure only. `validate` in validate.ts is what checks the tree against a
 * particular resource's fields and types, and nothing should compile a tree
 * that has not been through both.
 */
export const FilterTree = FilterNodeSchema.superRefine((node, ctx) => {
  const { nodes, depth } = measure(node);

  if (depth > MAX_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Filter nesting exceeds ${String(MAX_DEPTH)} levels.`,
    });
  }
  if (nodes > MAX_NODES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Filter exceeds ${String(MAX_NODES)} nodes.`,
    });
  }
});

/**
 * Counts nodes and measures depth iteratively.
 *
 * Iterative because this runs on a tree that has NOT yet been depth-checked — a
 * recursive version would be the stack overflow the limit exists to prevent.
 */
function measure(root: FilterNode): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;

  const stack: { node: FilterNode; level: number }[] = [{ node: root, level: 1 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    nodes += 1;
    if (current.level > depth) depth = current.level;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) break;

    if (current.node.kind === 'group') {
      for (const child of current.node.children) {
        stack.push({ node: child, level: current.level + 1 });
      }
    } else if (current.node.kind === 'not') {
      stack.push({ node: current.node.child, level: current.level + 1 });
    }
  }

  return { nodes, depth };
}

/* -------------------------------------------------------------------------- *
 * Constructors — for tests, the visual builder, and Phase 8's parser
 * -------------------------------------------------------------------------- */

export function compare(
  field: string,
  operator: Operator,
  value?: FilterValue | readonly FilterValue[],
): ComparisonNode {
  return value === undefined
    ? { kind: 'comparison', field, operator }
    : { kind: 'comparison', field, operator, value };
}

export function and(...children: readonly FilterNode[]): GroupNode {
  return { kind: 'group', combinator: 'and', children };
}

export function or(...children: readonly FilterNode[]): GroupNode {
  return { kind: 'group', combinator: 'or', children };
}

export function not(child: FilterNode): NotNode {
  return { kind: 'not', child };
}
