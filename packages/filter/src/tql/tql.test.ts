import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ME, and, compare, not, or, type ComparisonNode, type FilterNode } from '../ast.js';
import { validate } from '../validate.js';
import { compile } from '../compile.js';
import { evaluate } from '../evaluate.js';
import { fieldsOf } from '../fields.js';
import { tokenize } from './tokenize.js';
import { format } from './format.js';
import { parse, type ParseResult } from './parse.js';
import { resolveSymbolicDate, isSymbolicDate } from './relative-date.js';

/**
 * TQL Wave 1 (ai/phase-8-search.md §1).
 *
 * The property that matters throughout: **TQL text produces the same AST the
 * visual builder produces** — `parse(format(node))` is the identity over the
 * canonical tree class — and a user string becomes SQL only through the
 * existing closed field/operator tables and `$n` placeholders. The parser adds
 * no second path to SQL.
 */

const VIEWER = '0195cc00-0000-7000-8000-000000000001';
const NOW = new Date('2026-08-10T12:00:00.000Z');

/** Asserts a query parses and returns its (non-null) filter. */
function p(input: string): FilterNode {
  const result = parse(input);
  if (!result.ok) throw new Error(`unexpected parse failure: ${JSON.stringify(result.errors)}`);
  const filter = result.filter;
  if (filter === null) throw new Error(`expected a non-null filter for "${input}"`);
  return filter;
}

describe('tokenize', () => {
  it('classifies the token kinds', () => {
    const { tokens } = tokenize('status = Done');
    expect(tokens.map((t) => t.kind)).toEqual(['ident', 'op', 'ident', 'eof']);
    expect(tokens[0]?.text).toBe('status');
    expect(tokens[1]?.text).toBe('=');
  });

  it('decodes quoted strings, with escapes', () => {
    const { tokens } = tokenize('label = "in progress \\"quoted\\" now"');
    const string = tokens.find((t) => t.kind === 'string');
    expect(string?.value).toBe('in progress "quoted" now');
  });

  it('distinguishes numbers, relative dates, and @values', () => {
    const { tokens } = tokenize('updated > -7d points = 3 author = @me');
    expect(tokens.map((t) => t.kind)).toEqual([
      'ident',
      'op',
      'relative',
      'ident',
      'op',
      'number',
      'ident',
      'op',
      'at',
      'eof',
    ]);
    expect(tokens[2]?.value).toBe('-7d');
    expect(tokens[5]?.value).toBe(3);
    expect(tokens[8]?.value).toBe('me');
  });

  it('treats keyword-like words as keywords, case-insensitively', () => {
    const { tokens } = tokenize('a AND b or c not d');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.keyword)).toEqual([
      'AND',
      'OR',
      'NOT',
    ]);
  });

  it('carries offsets so the UI can underline the bad token', () => {
    const { tokens } = tokenize('type = card');
    expect(tokens[0]?.offset).toBe(0);
    expect(tokens[1]?.offset).toBe(5);
    expect(tokens[2]?.offset).toBe(7);
  });

  it('reports an unterminated string as a positioned error', () => {
    const { errors } = tokenize('title = "oops');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Unterminated');
    expect(errors[0]?.offset).toBe(8);
  });

  it('reports a lone ! and a bare @', () => {
    expect(tokenize('a ! b').errors).toHaveLength(1);
    expect(tokenize('@').errors).toHaveLength(1);
  });

  it('refuses a decimal followed by a relative unit', () => {
    // `7.5d` would be a relative date with fractional days, which the closed
    // vocabulary does not include — better an error than a silent misread.
    const { errors } = tokenize('updated > 7.5d');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('whole days');
  });
});

describe('parse', () => {
  it('parses a bare comparison', () => {
    expect(p('status = Done')).toEqual(compare('status', 'eq', 'Done'));
    expect(p('status != Done')).toEqual(compare('status', 'neq', 'Done'));
    expect(p('status <> Done')).toEqual(compare('status', 'neq', 'Done'));
    expect(p('points > 3')).toEqual(compare('points', 'gt', 3));
  });

  it('desugars field:value shorthand to equality', () => {
    expect(p('type:page')).toEqual(compare('type', 'eq', 'page'));
  });

  it('keeps @me symbolic', () => {
    expect(p('assignee = me')).toEqual(compare('assignee', 'eq', ME));
    expect(p('assignee = @me')).toEqual(compare('assignee', 'eq', ME));
    // Quotes are the escape: `= "me"` is the literal word.
    expect(p('title = "me"')).toEqual(compare('title', 'eq', 'me'));
    /* The literal string "@me" is NOT expressible — the AST's ME constant IS
       the string '@me', and validate's ME check runs before the type switch,
       so a quoted "@me" is treated as the symbol, not the text. Pre-existing
       AST design; pinned here so the parser's behavior stays consistent with
       the builder's. */
    expect(p('title = "@me"')).toEqual(compare('title', 'eq', '@me'));
    expect(validate('card', p('title = "@me"')).ok).toBe(false);
  });

  it('parses booleans and null as values, not strings', () => {
    expect(p('archived = true')).toEqual(compare('archived', 'eq', true));
    expect(p('due = null')).toEqual(compare('due', 'eq', null));
  });

  it('keeps relative dates symbolic', () => {
    expect(p('updated > -7d')).toEqual(compare('updated', 'gt', '-7d'));
    expect(p('created >= @today')).toEqual(compare('created', 'gte', '@today'));
  });

  it('applies NOT > AND > OR precedence', () => {
    // `a OR b AND c` groups as `a OR (b AND c)`.
    expect(p('type = card OR title = x AND text = y')).toEqual(
      or(
        compare('type', 'eq', 'card'),
        and(compare('title', 'eq', 'x'), compare('text', 'eq', 'y')),
      ),
    );
    expect(p('NOT type = card')).toEqual(not(compare('type', 'eq', 'card')));
    expect(p('NOT (type = card OR title = x)')).toEqual(
      not(or(compare('type', 'eq', 'card'), compare('title', 'eq', 'x'))),
    );
  });

  it('parses groups, including empty and single-child ones', () => {
    expect(p('(type = card)')).toEqual({
      kind: 'group',
      combinator: 'and',
      children: [compare('type', 'eq', 'card')],
    });
    expect(p('()')).toEqual({ kind: 'group', combinator: 'and', children: [] });
  });

  it('parses IN lists and NOT IN', () => {
    expect(p('type IN (card, message, page)')).toEqual(
      compare('type', 'in', ['card', 'message', 'page']),
    );
    expect(p('type NOT IN (message, page)')).toEqual(
      compare('type', 'not_in', ['message', 'page']),
    );
    // Keywords inside quotes are VALUES, not syntax.
    expect(p('label IN ("in progress", bug)')).toEqual(
      compare('label', 'in', ['in progress', 'bug']),
    );
  });

  it('parses is empty and is not empty', () => {
    expect(p('due IS EMPTY')).toEqual(compare('due', 'is_empty'));
    expect(p('due IS NOT EMPTY')).toEqual(compare('due', 'is_not_empty'));
  });

  it('turns bare terms and quoted phrases into text-contains comparisons', () => {
    expect(p('quarterly report')).toEqual(
      and(compare('text', 'contains', 'quarterly'), compare('text', 'contains', 'report')),
    );
    expect(p('"quarterly report"')).toEqual(compare('text', 'contains', 'quarterly report'));
    expect(p('report type:page')).toEqual(
      and(compare('text', 'contains', 'report'), compare('type', 'eq', 'page')),
    );
  });

  it('mixes free text with comparisons via implicit AND', () => {
    expect(p('report status = Done OR type = page')).toEqual(
      or(
        and(compare('text', 'contains', 'report'), compare('status', 'eq', 'Done')),
        compare('type', 'eq', 'page'),
      ),
    );
  });

  it('parses ORDER BY separately from the filter', () => {
    const result = parse('type = card ORDER BY title DESC') as Extract<ParseResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.filter).toEqual(compare('type', 'eq', 'card'));
    expect(result.orderBy).toEqual({ field: 'title', direction: 'desc' });

    // ASC is the default.
    const asc = parse('ORDER BY updated') as Extract<ParseResult, { ok: true }>;
    expect(asc.orderBy).toEqual({ field: 'updated', direction: 'asc' });
    expect(asc.filter).toBeNull();
  });

  it('returns errors with offsets instead of throwing', () => {
    const cases: readonly [string, string][] = [
      ['status =', 'Expected a value'],
      ['(a = b', 'Unclosed group'],
      ['type = card ORDER foo', 'Expected BY'],
      ['type = card ORDER BY', 'Expected a field name'],
      ['type = card ORDER BY title garbage', 'Unexpected'],
      ['= card', 'field name first'],
      ['type NOT card', 'Expected IN'],
      ['type IS banana', 'Expected EMPTY'],
      ['a = b c = d AND (x = y ORDER BY z)', 'ORDER BY is only allowed at the end'],
    ];
    for (const [input, fragment] of cases) {
      const result = parse(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toContain(fragment);
      expect(result.errors[0]?.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it('treats an empty query as no constraint', () => {
    expect(parse('')).toEqual({ ok: true, filter: null, orderBy: null });
    expect(parse('   ')).toEqual({ ok: true, filter: null, orderBy: null });
  });
});

describe('format', () => {
  it('renders canonical text for comparisons', () => {
    expect(format(compare('type', 'eq', 'card'))).toBe('type = card');
    expect(format(compare('type', 'in', ['card', 'message']))).toBe('type IN (card, message)');
    expect(format(compare('title', 'contains', 'quarterly report'))).toBe(
      'title CONTAINS "quarterly report"',
    );
    expect(format(compare('due', 'is_empty'))).toBe('due IS EMPTY');
    expect(format(compare('due', 'is_not_empty'))).toBe('due IS NOT EMPTY');
    expect(format(compare('archived', 'eq', true))).toBe('archived = true');
    expect(format(compare('due', 'eq', null))).toBe('due = null');
    expect(format(compare('author', 'eq', ME))).toBe('author = @me');
  });

  it('quotes exactly the values that would re-parse differently', () => {
    // `me`, `true`, keywords and `@`-prefixed words must be quoted so the round
    // trip is value-exact; `-7d` too, since a bare one is a relative-date token.
    expect(format(compare('title', 'eq', 'me'))).toBe('title = "me"');
    expect(format(compare('title', 'eq', 'true'))).toBe('title = "true"');
    expect(format(compare('title', 'eq', 'not'))).toBe('title = "not"');
    expect(format(compare('title', 'eq', '@ali'))).toBe('title = "@ali"');
    expect(format(compare('updated', 'eq', '-7d'))).toBe('updated = "-7d"');
  });

  it('parenthesizes groups and NOT', () => {
    expect(format(and(compare('a', 'eq', 'x'), compare('b', 'eq', 'y')))).toBe('(a = x AND b = y)');
    expect(format(or(compare('a', 'eq', 'x'), compare('b', 'eq', 'y')))).toBe('(a = x OR b = y)');
    expect(format(not(compare('a', 'eq', 'x')))).toBe('NOT a = x');
    expect(format(not(or(compare('a', 'eq', 'x'), compare('b', 'eq', 'y'))))).toBe(
      'NOT (a = x OR b = y)',
    );
  });

  it('renders null (no filter) as the empty string', () => {
    expect(format(null)).toBe('');
  });
});

describe('round trip — TQL text and the visual builder edit the same AST', () => {
  /** A property: `parse(format(node))` is the identity over canonical trees. */
  const roundTrips = (trees: fc.Arbitrary<FilterNode>): void => {
    fc.assert(
      fc.property(trees, (node) => {
        const text = format(node);
        const result = parse(text);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.filter).toEqual(node);
          // And formatting the re-parse is stable — the canonical form is a
          // fixed point, so saving and re-opening never churns the text.
          expect(format(result.filter)).toBe(text);
        }
      }),
    );
  };

  const searchLeaves = fc.oneof(
    fc.constant(compare('type', 'eq', 'card')),
    fc.constant(compare('type', 'in', ['card', 'message', 'page'])),
    fc.constant(compare('title', 'contains', 'quarterly report')),
    fc.constant(compare('text', 'contains', 'deploy outage')),
    fc.constant(compare('author', 'eq', ME)),
    fc.constant(compare('updated', 'gt', '-7d')),
    fc.constant(compare('created', 'gte', '@today')),
    fc.constant(compare('archived', 'eq', true)),
    fc.constant(compare('updated', 'is_empty')),
    fc.constant(compare('type', 'not_in', ['comment'])),
  );

  const cardLeaves = fc.oneof(
    fc.constant(compare('assignee', 'in', [ME])),
    fc.constant(compare('priority', 'eq', 'urgent')),
    fc.constant(compare('due', 'lt', '-7d')),
    fc.constant(compare('title', 'contains', 'bug')),
    fc.constant(compare('label', 'not_in', ['label-1'])),
    fc.constant(compare('number', 'gte', 3)),
    fc.constant(compare('archived', 'eq', false)),
  );

  /** A bounded-depth tree generator — recursion by size, no fc.letrec typing. */
  const treeOf = (leaves: fc.Arbitrary<FilterNode>): fc.Arbitrary<FilterNode> => {
    const at = (depth: number): fc.Arbitrary<FilterNode> => {
      if (depth <= 0) return leaves;
      // Groups have >= 2 children by construction — the canonical class the
      // formatter guarantees (see format.ts's header for why).
      return fc.oneof(
        leaves,
        at(depth - 1).map((child) => not(child)),
        fc.array(at(depth - 1), { minLength: 2, maxLength: 4 }).map((children) => and(...children)),
        fc.array(at(depth - 1), { minLength: 2, maxLength: 4 }).map((children) => or(...children)),
      );
    };
    return at(3);
  };

  it('round-trips search-resource trees', () => {
    roundTrips(treeOf(searchLeaves));
  });

  it('round-trips card-resource trees', () => {
    roundTrips(treeOf(cardLeaves));
  });

  it('every generated tree validates against its field set', () => {
    fc.assert(
      fc.property(treeOf(searchLeaves), (node) => {
        expect(validate('search', node).ok).toBe(true);
      }),
    );
  });
});

describe('symbolic dates — one tree, two backends, one clock', () => {
  it('isSymbolicDate is closed over the documented vocabulary', () => {
    for (const literal of ['@today', '@now', '-7d', '+3w', '-2mo']) {
      expect(isSymbolicDate(literal)).toBe(true);
    }
    for (const literal of ['7d', 'next friday', '2026-08-10T00:00:00Z', '-7', '@me']) {
      expect(isSymbolicDate(literal)).toBe(false);
    }
  });

  it('resolves relative offsets and @today against the injected clock', () => {
    expect(resolveSymbolicDate('-7d', NOW)).toBe('2026-08-03T12:00:00.000Z');
    expect(resolveSymbolicDate('+3w', NOW)).toBe('2026-08-31T12:00:00.000Z');
    expect(resolveSymbolicDate('@now', NOW)).toBe('2026-08-10T12:00:00.000Z');
    expect(resolveSymbolicDate('@today', NOW)).toBe('2026-08-10T00:00:00.000Z');
    // Months are calendar months — the same choice the notification sweeps make.
    expect(resolveSymbolicDate('-1mo', NOW)).toBe('2026-07-10T12:00:00.000Z');
  });

  it('validate accepts the literals and rejects the rest', () => {
    expect(validate('search', compare('updated', 'gt', '-7d')).ok).toBe(true);
    expect(validate('search', compare('created', 'gte', '@today')).ok).toBe(true);
    // A relative date on a non-date field is just a string, and a literal that
    // is not in the closed set stays an ISO-date error.
    expect(validate('search', compare('title', 'eq', '-7d')).ok).toBe(true);
    expect(validate('search', compare('updated', 'gt', 'next friday')).ok).toBe(false);
  });

  it('compile resolves the literal once, against the injected clock', () => {
    const { sql, params } = compile('search', compare('updated', 'gt', '-7d'), { now: NOW });
    expect(sql).toBe('search.documents.updated_at > $1::timestamptz');
    expect(params).toEqual(['2026-08-03T12:00:00.000Z']);
  });

  it('evaluate resolves to the same instant the compiler emits', () => {
    // 2026-08-05 is within the last 7 days of the injected clock; 2026-07-01 is not.
    const node = compare('updated', 'gt', '-7d');
    expect(evaluate('search', node, { updated: '2026-08-05T00:00:00Z' }, { now: NOW })).toBe(true);
    expect(evaluate('search', node, { updated: '2026-07-01T00:00:00Z' }, { now: NOW })).toBe(false);
  });

  it('a symbolic date survives save/re-open because the tree keeps it symbolic', () => {
    // The saved-query guarantee: the AST holds `-7d`, not a frozen timestamp.
    const node = p('updated > -7d') as ComparisonNode;
    expect(node.value).toBe('-7d');
    expect(validate('search', node).ok).toBe(true);
  });
});

describe('the search field set', () => {
  it('exposes the cross-product vocabulary', () => {
    const names = fieldsOf('search').map((field) => field.name);
    expect(names).toEqual(
      expect.arrayContaining(['type', 'title', 'text', 'author', 'updated', 'created', 'archived']),
    );
  });

  it('validates the PLAN.md example queries end to end', () => {
    // `type IN (message, page) AND updated > -7d` — from §10.2's own examples.
    const tree = p('type IN (message, page) AND updated > -7d');
    expect(validate('search', tree).ok).toBe(true);
    expect(compile('search', tree, { now: NOW }).sql).toContain(
      'search.documents.entity_type IN ($1, $2)',
    );
  });

  it('validates card-resource TQL end to end, exactly as strict as the builder', () => {
    /* §10.2's example shape, on the CARD field set. Two of the prose examples
       deliberately do NOT appear here: `status != Done` and `assignee = me`
       both fail validation, because `status` and `assignee` are UUID fields
       (status_id / assignee_ids) and `Done` is not a uuid while an array field
       answers membership, not equality. The builder inserts real ids and uses
       `in`; TQL is no looser — that is the point of sharing the whitelist. */
    const tree = p('assignee IN (me) AND due < -7d');
    expect(validate('card', tree).ok).toBe(true);
    const { params } = compile('card', tree, { viewerId: VIEWER, now: NOW });
    expect(params).toEqual([VIEWER, '2026-08-03T12:00:00.000Z']);
  });

  it('enforces the closed enum on type', () => {
    expect(validate('search', compare('type', 'eq', 'card')).ok).toBe(true);
    expect(validate('search', compare('type', 'eq', 'banana')).ok).toBe(false);
  });

  it('accepts @me only on the author field', () => {
    expect(validate('search', compare('author', 'eq', ME)).ok).toBe(true);
    expect(validate('search', compare('title', 'eq', ME)).ok).toBe(false);
  });

  it('compiles to the search.documents projection columns', () => {
    expect(compile('search', compare('title', 'contains', 'x')).sql).toContain(
      'search.documents.title',
    );
    expect(compile('search', compare('text', 'contains', 'x')).sql).toContain(
      'search.documents.body',
    );
    expect(compile('search', compare('archived', 'eq', true)).sql).toContain(
      'search.documents.archived',
    );
  });

  it('never lets a user string reach SQL as a field or operator', () => {
    // The parser + validator + compiler together: the dangerous input is a
    // VALUE, parameterized like every other value.
    const tree = p(`title CONTAINS "'; DROP TABLE search.documents;--"`);
    const { sql, params } = compile('search', tree);
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('"');
    expect(params).toEqual(["%'; DROP TABLE search.documents;--%"]);
  });
});
