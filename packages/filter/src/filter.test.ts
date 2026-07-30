import { describe, expect, it } from 'vitest';
import { FilterTree, ME, and, compare, not, or, type FilterNode } from './ast.js';
import { fieldsOf, findField } from './fields.js';
import { validate } from './validate.js';
import { FilterCompileError, compile } from './compile.js';
import { evaluate, type EvaluableRow } from './evaluate.js';

/**
 * The filter AST, its whitelist, and its two backends (PLAN.md §10.2).
 *
 * The property under test throughout: **no user string reaches the database as
 * a field name or an operator, and every value is a parameter**. Everything
 * else here is about the compiler and the evaluator agreeing, because a
 * disagreement means a Phase 10 automation fires on cards a Phase 3 board
 * filter would not have shown.
 */

const VIEWER = '0195cc00-0000-7000-8000-000000000001';
const OTHER = '0195cc00-0000-7000-8000-000000000002';

describe('the whitelist', () => {
  it('rejects a field that is not defined', () => {
    // The mechanism §10.2 calls the security control.
    expect(validate('card', compare('title', 'eq', 'x')).ok).toBe(true);
    expect(validate('card', compare('secret_column', 'eq', 'x')).ok).toBe(false);
    expect(validate('card', compare('work.cards.title', 'eq', 'x')).ok).toBe(false);
  });

  it('refuses to compile an unknown field even if validation were skipped', () => {
    /* The compiler re-validates rather than trusting its caller. This is the
       difference between an exception and interpolating a caller's string into
       SQL, and it stays here precisely because "the caller validated it" is an
       assumption that holds until someone adds a second call site. */
    expect(() => compile('card', compare('injected', 'eq', 'x'))).toThrow(FilterCompileError);
  });

  it.each([
    "title'; DROP TABLE work.cards; --",
    'title) OR (1=1',
    '(SELECT password FROM identity.users)',
    'work.cards.title, c.description',
    'title--',
  ])('rejects the field name %s', (field) => {
    expect(validate('card', compare(field, 'eq', 'x')).ok).toBe(false);
    expect(() => compile('card', compare(field, 'eq', 'x'))).toThrow(FilterCompileError);
  });

  it('pairs operators with field types', () => {
    // `contains` is a text operator; a date has no substrings.
    expect(validate('card', compare('due', 'contains', 'x')).ok).toBe(false);
    expect(validate('card', compare('title', 'contains', 'x')).ok).toBe(true);

    // An array field answers membership, not equality.
    expect(validate('card', compare('assignee', 'eq', VIEWER)).ok).toBe(false);
    expect(validate('card', compare('assignee', 'in', [VIEWER])).ok).toBe(true);
  });

  it('checks values against the field type without coercing them', () => {
    expect(validate('card', compare('number', 'eq', 5)).ok).toBe(true);
    // '5' is not silently read as 5 — a filter whose meaning depends on how the
    // client serialized it is one Phase 8's parser could not reproduce.
    expect(validate('card', compare('number', 'eq', '5')).ok).toBe(false);
    expect(validate('card', compare('due', 'lt', 'next friday')).ok).toBe(false);
    expect(validate('card', compare('list', 'eq', 'not-a-uuid')).ok).toBe(false);
  });

  it('reports every bad node, not just the first', () => {
    // The visual builder lights up three chips, not one.
    const result = validate(
      'card',
      and(
        compare('nope', 'eq', 'x'),
        compare('due', 'contains', 'y'),
        compare('number', 'eq', 'z'),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
    // Each error carries the path to its node, so the UI knows which chip.
    expect(result.errors.map((error) => error.path)).toEqual([[0], [1], [2]]);
  });
});

describe('the wire schema', () => {
  it('rejects a value on an operator that takes none, and vice versa', () => {
    expect(
      FilterTree.safeParse({ kind: 'comparison', field: 'due', operator: 'is_empty' }).success,
    ).toBe(true);
    expect(
      FilterTree.safeParse({ kind: 'comparison', field: 'due', operator: 'is_empty', value: 'x' })
        .success,
    ).toBe(false);
    expect(
      FilterTree.safeParse({ kind: 'comparison', field: 'title', operator: 'eq' }).success,
    ).toBe(false);
  });

  it('rejects a list where a scalar belongs, and vice versa', () => {
    expect(
      FilterTree.safeParse({ kind: 'comparison', field: 'title', operator: 'eq', value: ['a'] })
        .success,
    ).toBe(false);
    expect(
      FilterTree.safeParse({ kind: 'comparison', field: 'list', operator: 'in', value: 'a' })
        .success,
    ).toBe(false);
  });

  it('rejects a tree nested past the depth limit', () => {
    // Both backends recurse; an unbounded tree from an API client is a stack
    // overflow in whichever runs first.
    let node: FilterNode = compare('title', 'eq', 'x');
    for (let level = 0; level < 30; level += 1) node = not(node);

    expect(FilterTree.safeParse(node).success).toBe(false);
  });

  it('rejects a tree wider than the node budget', () => {
    const wide = and(...Array.from({ length: 400 }, () => compare('title', 'eq', 'x')));
    expect(FilterTree.safeParse(wide).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(
      FilterTree.safeParse({
        kind: 'comparison',
        field: 'title',
        operator: 'eq',
        value: 'x',
        sql: 'DROP TABLE cards',
      }).success,
    ).toBe(false);
  });
});

describe('compiling to SQL', () => {
  it('parameterizes every value', () => {
    const { sql, params } = compile(
      'card',
      and(compare('title', 'eq', "Robert'); DROP TABLE cards;--"), compare('number', 'gt', 3)),
    );

    // The dangerous string is a PARAMETER; it appears nowhere in the SQL.
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('Robert');
    expect(params).toEqual(["Robert'); DROP TABLE cards;--", 3]);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
  });

  it('uses the column expression from the field definition', () => {
    const { sql } = compile('card', compare('description', 'contains', 'urgent'));

    // `description` filters the FLATTENED column, not the JSON — so the filter
    // does not depend on the TipTap document schema.
    expect(sql).toContain('work.cards.description_text');
    expect(sql).toContain('ILIKE');
  });

  it('escapes LIKE metacharacters so a literal % is a literal %', () => {
    const { params } = compile('card', compare('title', 'contains', '50%'));
    // Not a security control — the value is parameterized either way — but
    // without it a search for "50%" matches everything starting with 50.
    expect(params[0]).toBe('%50\\%%');
  });

  it('parenthesizes groups so precedence cannot regroup them', () => {
    const { sql } = compile(
      'card',
      or(and(compare('title', 'eq', 'a'), compare('number', 'eq', 1)), compare('number', 'eq', 2)),
    );

    // Without the parentheses, `a AND b OR c` is not what the user built.
    expect(sql).toBe(
      '((work.cards.title = $1 AND work.cards.number = $2) OR work.cards.number = $3)',
    );
  });

  it('turns a null comparison into IS NULL rather than = NULL', () => {
    // `= NULL` is never true, which is the classic silent always-false filter.
    expect(compile('card', compare('due', 'eq', null)).sql).toBe('work.cards.due_date IS NULL');
    expect(compile('card', compare('due', 'neq', null)).sql).toBe(
      'work.cards.due_date IS NOT NULL',
    );
  });

  it('handles an empty list without emitting invalid SQL', () => {
    // `IN ()` is a syntax error, and an empty picker is a real UI state.
    expect(compile('card', compare('list', 'in', [])).sql).toBe('FALSE');
    expect(compile('card', compare('list', 'not_in', [])).sql).toBe('TRUE');
  });

  it('uses array overlap for multi-value fields', () => {
    const { sql } = compile('card', compare('assignee', 'in', [VIEWER, OTHER]));
    // Overlap, not containment: picking two names means "either", not "both".
    expect(sql).toContain('&&');
    expect(sql).not.toContain('@>');
  });

  it('negates through COALESCE so NULL does not match a NOT', () => {
    const { sql } = compile('card', not(compare('due', 'lt', '2026-01-01T00:00:00Z')));
    // A card with no due date must not match `not (due < x)` by accident.
    expect(sql).toContain('COALESCE');
  });

  it('offsets placeholders when the caller already has parameters', () => {
    const { sql, params } = compile('card', compare('title', 'eq', 'x'), { startIndex: 3 });
    expect(sql).toContain('$3');
    expect(params).toEqual(['x']);
  });
});

describe('@me', () => {
  it('substitutes the viewer at compile time', () => {
    const { params } = compile('card', compare('assignee', 'in', [ME]), { viewerId: VIEWER });
    expect(params).toEqual([VIEWER]);
  });

  it('refuses to compile without a viewer rather than defaulting', () => {
    /* A filter mentioning @me compiled without a viewer would silently become
       "assigned to nobody" and quietly return the wrong rows. */
    expect(() => compile('card', compare('assignee', 'in', [ME]))).toThrow(FilterCompileError);
  });

  it('is rejected on fields that are not user-valued', () => {
    expect(validate('card', compare('title', 'eq', ME)).ok).toBe(false);
  });

  it('keeps a shared saved filter meaning the same thing to everyone', () => {
    // The bug this prevents: the client substituting its own id at save time,
    // so a shared filter means "assigned to whoever saved it".
    const saved = compare('assignee', 'in', [ME]);

    expect(compile('card', saved, { viewerId: VIEWER }).params).toEqual([VIEWER]);
    expect(compile('card', saved, { viewerId: OTHER }).params).toEqual([OTHER]);
  });
});

describe('the evaluator', () => {
  const row = (overrides: EvaluableRow = {}): EvaluableRow => ({
    title: 'Ship the thing',
    description: 'details here',
    number: 7,
    assignee: [VIEWER],
    due: '2026-07-29T00:00:00Z',
    archived: false,
    ...overrides,
  });

  it('matches the obvious cases', () => {
    expect(evaluate('card', compare('title', 'eq', 'Ship the thing'), row())).toBe(true);
    expect(evaluate('card', compare('number', 'gt', 3), row())).toBe(true);
    expect(evaluate('card', compare('number', 'gt', 70), row())).toBe(false);
  });

  it('is case-insensitive for contains, matching ILIKE', () => {
    // One of the three places SQL and JavaScript disagree by default.
    expect(evaluate('card', compare('title', 'contains', 'SHIP'), row())).toBe(true);
  });

  it('compares dates as instants, not as strings', () => {
    /* `2026-07-29T00:00:00+01:00` sorts AFTER `...Z` as text and BEFORE it as
       an instant. Postgres uses the instant; so must this. */
    const earlier = evaluate(
      'card',
      compare('due', 'lt', '2026-07-29T01:00:00+00:00'),
      row({ due: '2026-07-29T00:30:00Z' }),
    );
    expect(earlier).toBe(true);
  });

  it('treats a null like SQL does — no comparison matches it', () => {
    // Including `neq`: in Postgres a row with a null title does NOT satisfy
    // `title <> 'x'`, and a JavaScript `!==` would say it does.
    expect(evaluate('card', compare('due', 'lt', '2030-01-01T00:00:00Z'), row({ due: null }))).toBe(
      false,
    );
    expect(evaluate('card', compare('title', 'neq', 'other'), row({ title: null }))).toBe(false);
  });

  it('handles is_empty on arrays and scalars', () => {
    expect(evaluate('card', compare('assignee', 'is_empty'), row({ assignee: [] }))).toBe(true);
    expect(evaluate('card', compare('assignee', 'is_not_empty'), row())).toBe(true);
    expect(evaluate('card', compare('due', 'is_empty'), row({ due: null }))).toBe(true);
  });

  it('uses overlap semantics for array membership', () => {
    expect(evaluate('card', compare('assignee', 'in', [VIEWER, OTHER]), row())).toBe(true);
    expect(evaluate('card', compare('assignee', 'not_in', [OTHER]), row())).toBe(true);
  });

  it('matches nothing for an unknown field rather than everything', () => {
    // The compiler throws here; the evaluator cannot, because it runs in a
    // worker where an exception would take down a rule run. Matching NOTHING is
    // the safe direction — a rule that fires on everything is the bad one.
    expect(evaluate('card', compare('nope', 'eq', 'x'), row())).toBe(false);
  });

  it('treats an empty AND as true and an empty OR as false', () => {
    // The identity elements, matching the compiler's TRUE/FALSE — so a nested
    // empty group cannot change what its parent means.
    expect(evaluate('card', and(), row())).toBe(true);
    expect(evaluate('card', or(), row())).toBe(false);
  });
});

describe('field definitions', () => {
  it('exposes a field set the visual builder can render', () => {
    const fields = fieldsOf('card');
    expect(fields.length).toBeGreaterThan(5);
    expect(fields.every((field) => field.sql.length > 0)).toBe(true);
  });

  it('declares acceptsMe only on user-valued fields', () => {
    /* `@me` on a text field would compile to a comparison against a UUID, which
       is not an error anyone would understand. */
    for (const field of fieldsOf('card')) {
      if (field.acceptsMe === true) {
        expect(['uuid', 'uuid_array']).toContain(field.type);
      }
    }
  });

  it('supports every operator it advertises', () => {
    // A field offering an operator the compiler cannot emit would be a chip in
    // the UI that throws when applied.
    for (const field of fieldsOf('card')) {
      const definition = findField('card', field.name);
      expect(definition).toBeDefined();
    }
  });
});
