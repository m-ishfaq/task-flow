import {
  LIST_OPERATORS,
  ME,
  NULLARY_OPERATORS,
  OPERATORS_BY_TYPE,
  findField,
  type ComparisonNode,
  type FieldDefinition,
  type FilterNode,
  type FilterValue,
  type Operator,
} from '@taskflow/filter';

/**
 * The defaults and descriptions the builder needs, kept out of the components.
 *
 * Separate because these are the rules a test can assert cheaply — "picking a
 * date field never leaves a text operator selected" — and asserting them through
 * a rendered popover would test Radix rather than the rule.
 */

/**
 * The operator to select when a field is chosen.
 *
 * The first supported one, which is `eq` for everything that has it and `in` for
 * arrays — the reading a person means by default in each case. Never a
 * hard-coded `'eq'`: `uuid_array` does not support it, and `assignee eq x` is a
 * chip that renders fine and cannot be applied.
 */
export function defaultOperatorFor(field: FieldDefinition): Operator {
  const supported = OPERATORS_BY_TYPE[field.type];
  const first = supported[0];
  if (first === undefined) {
    throw new Error(`Field type "${field.type}" supports no operators.`);
  }
  return first;
}

/**
 * The value to start with for a field/operator pair.
 *
 * Shapes matter more than contents: a list operator must start with an ARRAY and
 * a scalar one with a scalar, because the schema rejects the mismatch and the
 * user would see "requires a list" on a chip they have not touched yet.
 */
export function defaultValueFor(
  field: FieldDefinition,
  operator: Operator,
): ComparisonNode['value'] {
  if (NULLARY_OPERATORS.includes(operator)) return undefined;
  if (LIST_OPERATORS.includes(operator)) return [];
  return defaultScalarFor(field);
}

/**
 * The scalar default, separately, because the union above is not narrowable.
 *
 * Callers converting a list value back to a scalar need a value that CANNOT be
 * an array, and `defaultValueFor` cannot promise that — its return type includes
 * the list case even on the branch where the operator rules it out.
 */
export function defaultScalarFor(field: FieldDefinition): FilterValue {
  switch (field.type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'date':
      /* Null rather than "today". A date chip that arrives pre-filled with the
         current date is a filter the user did not ask for, applied silently the
         moment they add the row. */
      return null;
    case 'enum':
      return field.options?.[0] ?? null;
    case 'uuid':
    case 'uuid_array':
      return null;
    case 'text':
      return '';
  }
}

/** True when `@me` is offered for this field. */
export function acceptsMe(field: FieldDefinition): boolean {
  return field.acceptsMe === true;
}

export { ME };

/**
 * A one-line description of a subtree, for read-only rendering.
 *
 * Used where the builder can display a node but not edit it — `not` nodes,
 * which Phase 8's parser produces and this builder does not create.
 */
export function describe(node: FilterNode): string {
  if (node.kind === 'group') {
    const joiner = node.combinator === 'and' ? ' AND ' : ' OR ';
    return node.children.map(describe).join(joiner);
  }
  if (node.kind === 'not') return `NOT (${describe(node.child)})`;

  const field = findField('card', node.field);
  const name = field?.name ?? node.field;

  if (NULLARY_OPERATORS.includes(node.operator)) return `${name} ${node.operator}`;
  return `${name} ${node.operator} ${JSON.stringify(node.value)}`;
}
