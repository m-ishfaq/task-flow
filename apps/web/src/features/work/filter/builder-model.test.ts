import { describe, expect, it } from 'vitest';
import {
  LIST_OPERATORS,
  ME,
  NULLARY_OPERATORS,
  and,
  compare,
  fieldsOf,
  findField,
  validate,
  type FilterNode,
} from '@taskflow/filter';
import { defaultOperatorFor, defaultScalarFor, defaultValueFor } from './builder-model.js';

/**
 * The builder's defaults, checked against the REAL validator.
 *
 * The property that matters: **the builder cannot construct a chip the server
 * would reject.** Not "usually does not" — every field in the whitelist, with
 * its default operator and default value, has to validate. Otherwise a user
 * picks a field from a dropdown, touches nothing else, and Apply is disabled
 * with an error about a control they never used.
 *
 * `validate` here is the same function the API calls before compiling
 * (packages/filter/src/validate.ts), so this is not a restatement of its rules —
 * it is the rules.
 */

const FIELDS = fieldsOf('card');

describe('a freshly picked field always produces a valid chip', () => {
  it.each(FIELDS.map((field) => [field.name] as const))('for %s', (name) => {
    const field = findField('card', name);
    expect(field).toBeDefined();
    if (field === undefined) return;

    const operator = defaultOperatorFor(field);
    const value = defaultValueFor(field, operator);

    const node: FilterNode =
      value === undefined ? compare(field.name, operator) : compare(field.name, operator, value);

    const result = validate('card', node);
    expect(result.ok, `${name} ${operator} ${JSON.stringify(value)} was rejected`).toBe(true);
  });
});

describe('defaultOperatorFor', () => {
  it('never picks an operator the field type does not support', () => {
    /* The specific failure this rules out: hard-coding `'eq'`. `uuid_array`
       does not support it — `assignee eq x` compares a whole set against one
       value — so a naive default renders a chip that cannot be applied on the
       single most-used filter in any tracker. */
    for (const field of FIELDS) {
      const operator = defaultOperatorFor(field);
      const node = NULLARY_OPERATORS.includes(operator)
        ? compare(field.name, operator)
        : compare(field.name, operator, defaultValueFor(field, operator));

      expect(validate('card', node).ok).toBe(true);
    }
  });

  it('picks a list operator for array fields', () => {
    const assignee = findField('card', 'assignee');
    expect(assignee).toBeDefined();
    if (assignee === undefined) return;

    expect(LIST_OPERATORS).toContain(defaultOperatorFor(assignee));
  });

  it('picks a list operator for labels, which are an aggregate', () => {
    // `label` was declared `uuid` until a parity test caught it; see the note in
    // packages/filter/src/fields.ts. This pins the builder side of that fix.
    const label = findField('card', 'label');
    expect(label).toBeDefined();
    if (label === undefined) return;

    expect(LIST_OPERATORS).toContain(defaultOperatorFor(label));
  });
});

describe('defaultValueFor', () => {
  it('starts a list operator with an array and a scalar operator with a scalar', () => {
    const title = findField('card', 'title');
    const list = findField('card', 'list');
    expect(title).toBeDefined();
    expect(list).toBeDefined();
    if (title === undefined || list === undefined) return;

    expect(defaultValueFor(title, 'eq')).toBe('');
    expect(defaultValueFor(list, 'in')).toEqual([]);
    // A nullary operator takes NO value — the schema rejects one that carries a
    // spare, and `exactOptionalPropertyTypes` makes `{ value: undefined }`
    // different from omitting the key.
    expect(defaultValueFor(title, 'is_empty')).toBeUndefined();
  });

  it('does not pre-fill a date', () => {
    /* A date chip arriving with today's date already in it is a filter the user
       did not ask for, silently applied the moment they add the row. */
    const due = findField('card', 'due');
    expect(due).toBeDefined();
    if (due === undefined) return;

    expect(defaultValueFor(due, 'eq')).toBeNull();
  });

  it('never returns an array from defaultScalarFor', () => {
    // The narrowing path: converting a list chip back to a scalar needs a value
    // that cannot itself be a list.
    for (const field of FIELDS) {
      expect(Array.isArray(defaultScalarFor(field))).toBe(false);
    }
  });
});

describe('@me', () => {
  it('validates on user fields and is rejected everywhere else', () => {
    /* The reason `@me` is checked at VALIDATION time and not only at compile
       time: a builder that could render `title = @me` as a valid chip would
       produce one that explodes on Apply. */
    expect(validate('card', compare('assignee', 'in', [ME])).ok).toBe(true);
    expect(validate('card', compare('creator', 'eq', ME)).ok).toBe(true);
    expect(validate('card', compare('title', 'eq', ME)).ok).toBe(false);
  });
});

describe('the tree the builder emits', () => {
  it('is a group, and an empty one constrains nothing', () => {
    // The builder always edits a group so the AND/OR toggle has something to
    // toggle. An empty one has to be legal, or a fresh filter panel would show
    // a validation error before the user has done anything.
    expect(validate('card', and()).ok).toBe(true);
  });

  it('validates a realistic multi-condition filter', () => {
    const filter = and(
      compare('assignee', 'in', [ME]),
      compare('due', 'lt', '2026-08-01T00:00:00.000Z'),
      compare('archived', 'eq', false),
    );

    expect(validate('card', filter).ok).toBe(true);
  });
});
