/**
 * TQL parser (ai/phase-8-search.md §1.3).
 *
 * The second stage of `tokenize → parse → validate → compile`, and the whole
 * point of the phase: text in, the SAME tree out.
 *
 *   Phase 3   visual builder ──► AST ──► SQL compiler      (board views)
 *   Phase 10  automation      ──► AST ──► in-memory evaluator
 *   Phase 8   TQL text ──► parser ──► AST                   (this file)
 *
 * The parser is RESOURCE-AGNOSTIC. It knows the grammar and nothing about
 * fields — `validate(resource, ast)` is what decides a field name means
 * something. That split is why a parser built for search is also the parser
 * a board filter text box and a Phase 10 automation condition will use.
 *
 * ## Precedence, and the one choice that matters
 *
 *   NOT  >  AND  >  OR
 *
 * The visual builder produces trees where a group is either all-AND or
 * all-OR, and the parser mirrors that: `a OR b AND c` is `a OR (b AND c)`.
 *
 * ## What the parser does NOT do
 *
 * - It does not resolve `@me` — that stays symbolic until compile time, the
 *   same rule `view.service.ts` records for saved views.
 * - It does not resolve relative dates (`-7d`) — see tql/relative-date.ts.
 * - It does not validate field names or value types — `validate` does.
 * - ORDER BY is NOT part of the AST. The board filter has no ordering
 *   concept, and cramming it into FilterNode would force `compile` and
 *   `evaluate` to carry something they deliberately do not have. It is
 *   returned separately.
 */

import { and, compare, ME, not, or, type FilterNode, type FilterValue } from '../ast.js';
import { tokenize, type Token } from './tokenize.js';

/** A positioned parse error, for the UI to underline. */
export interface TqlError {
  readonly offset: number;
  readonly length: number;
  readonly message: string;
}

export interface OrderBy {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export type ParseResult =
  | {
      readonly ok: true;
      /** Null for an empty query — "no constraint", like an empty group. */
      readonly filter: FilterNode | null;
      readonly orderBy: OrderBy | null;
    }
  | { readonly ok: false; readonly errors: readonly TqlError[] };

class ParseFailure extends Error {
  constructor(readonly error: TqlError) {
    super(error.message);
    this.name = 'ParseFailure';
  }
}

/**
 * Parses a TQL query into the shared AST.
 *
 * Returns errors rather than throwing, mirroring `validate.ts`'s "show all the
 * problems at once" contract — a query with two bad tokens reports both, and
 * the UI underlines each by its offset.
 */
export function parse(input: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(input);
  if (lexErrors.length > 0) return { ok: false, errors: lexErrors };

  const parser = new Parser(tokens);
  try {
    const first = parser.peek();
    // An empty query, or one that is only ORDER BY, has no filter at all.
    const filter: FilterNode | null =
      first.kind === 'eof' || (first.kind === 'keyword' && first.keyword === 'ORDER')
        ? null
        : parser.parseOr();

    const orderBy = parser.parseOrderBy();

    const trailing = parser.peek();
    if (trailing.kind !== 'eof') {
      throw new ParseFailure({
        offset: trailing.offset,
        length: trailing.length,
        message: `Unexpected ${describe(trailing)}.`,
      });
    }

    return { ok: true, filter, orderBy };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, errors: [error.error] };
    throw error;
  }
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** Public: the top-level `parse` drives the walk and inspects the first token. */
  peek(): Token {
    const current = this.tokens[this.pos];
    if (current !== undefined) return current;
    // The eof sentinel is always pushed last, so the array is never empty.
    const last = this.tokens[this.tokens.length - 1];
    if (last === undefined) throw new Error('unreachable: token stream has no eof sentinel');
    return last;
  }

  private next(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  private fail(token: Token, message: string): never {
    throw new ParseFailure({ offset: token.offset, length: token.length, message });
  }

  /**
   * OR is the loosest binder. `a OR b AND c` groups as `a OR (b AND c)` —
   * the precedence table at the top of this file.
   */
  parseOr(): FilterNode {
    const parts = [this.parseAnd()];
    while (this.peek().kind === 'keyword' && this.peek().keyword === 'OR') {
      this.next();
      parts.push(this.parseAnd());
    }
    if (parts.length === 1) {
      const only = parts[0];
      if (only === undefined) throw new Error('unreachable: parseOr always parses one part');
      return only;
    }
    return or(...parts);
  }

  /**
   * AND binds tighter than OR. Implicit AND is what free text and adjacent
   * comparisons get: `report status = Done` is `report AND status = Done`.
   * Explicit `AND` and implicit AND parse identically, which is why
   * `report status = Done OR type = page` groups as
   * `(report AND status = Done) OR type = page` — standard precedence.
   */
  private parseAnd(): FilterNode {
    const terms = [this.parseTerm()];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'keyword' && token.keyword === 'AND') {
        this.next();
        terms.push(this.parseTerm());
        continue;
      }
      if (token.kind === 'keyword' && token.keyword === 'OR') break;
      if (
        token.kind === 'eof' ||
        token.kind === 'rparen' ||
        (token.kind === 'keyword' && token.keyword === 'ORDER')
      ) {
        break;
      }
      // Implicit AND: anything else starts a new term.
      terms.push(this.parseTerm());
    }
    if (terms.length === 1) {
      const only = terms[0];
      if (only === undefined) throw new Error('unreachable: parseAnd always parses one term');
      return only;
    }
    return and(...terms);
  }

  private parseTerm(): FilterNode {
    const token = this.peek();

    if (token.kind === 'keyword' && token.keyword === 'NOT') {
      this.next();
      // NOT binds tightest: `NOT a = b` is NOT (a = b), and `NOT (a OR b)`
      // reaches the group through the parens branch below.
      return not(this.parseTerm());
    }

    if (token.kind === 'keyword' && token.keyword === 'ORDER') {
      this.fail(token, 'ORDER BY is only allowed at the end of the query.');
    }

    if (token.kind === 'lparen') {
      this.next();
      if (this.peek().kind === 'rparen') {
        // `()` — an empty group means "no constraint" (ast.ts).
        this.next();
        return { kind: 'group', combinator: 'and', children: [] };
      }
      const inner = this.parseOr();
      const close = this.peek();
      /* ORDER BY is only legal at the top level — parseAnd stops before it,
         so reaching it here means it sat inside a group. "Unclosed group"
         would be a lie; the group IS closed, just closed around a clause
         that cannot be inside one. */
      if (close.kind === 'keyword' && close.keyword === 'ORDER') {
        this.fail(close, 'ORDER BY is only allowed at the end of the query.');
      }
      if (close.kind !== 'rparen') this.fail(close, 'Unclosed group — expected ")".');
      this.next();
      // Wrap a non-group inner expression in a single-child group so the
      // round trip is structural: format() renders a group with parens, and
      // parens always come back as a group. `(a AND b)` is already a group
      // and must not be double-wrapped.
      return inner.kind === 'group'
        ? inner
        : { kind: 'group', combinator: 'and', children: [inner] };
    }

    return this.parseAtom();
  }

  /**
   * An atom is either a comparison (ident followed by an operator) or free
   * text (anything else — the desugar in freeText()).
   */
  private parseAtom(): FilterNode {
    const token = this.peek();

    if (token.kind === 'ident' && this.startsComparison(this.tokens[this.pos + 1])) {
      this.next();
      return this.parseComparison(token.text);
    }

    if (
      token.kind === 'ident' ||
      token.kind === 'string' ||
      token.kind === 'number' ||
      token.kind === 'relative' ||
      token.kind === 'at'
    ) {
      return this.freeText(token);
    }

    if (token.kind === 'op') {
      this.fail(token, `Unexpected "${token.text}" — a comparison needs a field name first.`);
    }
    this.fail(token, `Unexpected ${describe(token)}.`);
  }

  /** True when the token after an ident is one that makes the ident a FIELD. */
  private startsComparison(next: Token | undefined): boolean {
    if (!next) return false;
    if (next.kind === 'op' || next.kind === 'colon') return true;
    if (next.kind === 'keyword') {
      return (
        next.keyword === 'CONTAINS' ||
        next.keyword === 'IN' ||
        next.keyword === 'IS' ||
        next.keyword === 'NOT'
      );
    }
    return false;
  }

  private parseComparison(field: string): FilterNode {
    /* The field token was already consumed by parseAtom — the operator is what
       this call reads next. */
    const op = this.next();

    if (op.kind === 'colon') {
      // `type:page` — the shorthand users expect from every other tracker.
      return compare(field, 'eq', this.parseValue());
    }

    if (op.kind === 'op') {
      switch (op.text) {
        case '=':
          return compare(field, 'eq', this.parseValue());
        case '!=':
        case '<>':
          return compare(field, 'neq', this.parseValue());
        case '<':
          return compare(field, 'lt', this.parseValue());
        case '<=':
          return compare(field, 'lte', this.parseValue());
        case '>':
          return compare(field, 'gt', this.parseValue());
        case '>=':
          return compare(field, 'gte', this.parseValue());
        default:
          this.fail(op, `Unknown operator "${op.text}".`);
      }
    }

    if (op.kind === 'keyword') {
      if (op.keyword === 'CONTAINS') {
        return compare(field, 'contains', this.parseValue());
      }
      if (op.keyword === 'IN') {
        return compare(field, 'in', this.parseList());
      }
      if (op.keyword === 'NOT') {
        const after = this.peek();
        if (after.kind === 'keyword' && after.keyword === 'IN') {
          this.next();
          return compare(field, 'not_in', this.parseList());
        }
        this.fail(after, 'Expected IN after NOT.');
      }
      if (op.keyword === 'IS') {
        const after = this.peek();
        if (after.kind === 'keyword' && after.keyword === 'EMPTY') {
          this.next();
          return compare(field, 'is_empty');
        }
        if (after.kind === 'keyword' && after.keyword === 'NOT') {
          this.next();
          const rest = this.peek();
          if (rest.kind === 'keyword' && rest.keyword === 'EMPTY') {
            this.next();
            return compare(field, 'is_not_empty');
          }
          this.fail(rest, 'Expected EMPTY after NOT.');
        }
        this.fail(after, 'Expected EMPTY after IS.');
      }
    }

    this.fail(op, `Unexpected ${describe(op)} after "${field}".`);
  }

  /** `IN (a, b)` — or `IN ()`, which compile() already turns into FALSE. */
  private parseList(): readonly FilterValue[] {
    const open = this.peek();
    if (open.kind !== 'lparen') this.fail(open, 'Expected "(" to start the list.');
    this.next();

    const values: FilterValue[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'rparen') {
        this.next();
        return values;
      }
      if (token.kind === 'eof') this.fail(token, 'Unclosed list — expected ")".');
      values.push(this.parseValue());

      const after = this.peek();
      if (after.kind === 'rparen') {
        this.next();
        return values;
      }
      if (after.kind === 'comma') {
        this.next();
        continue;
      }
      this.fail(after, 'Expected "," or ")" in the list.');
    }
  }

  /**
   * A value after an operator. `me`/`@me` desugar to the symbolic ME constant
   * (quotes are the escape: `title = "me"` is the literal word); `true`/
   * `false` are booleans because the AST's boolean type requires them (the
   * same strictness rule as validate.ts — a filter that silently reinterprets
   * `"true"` as `true` is a filter whose meaning depends on how it was typed).
   */
  private parseValue(): FilterValue {
    const token = this.peek();

    switch (token.kind) {
      case 'string':
        this.next();
        return token.value as string;
      case 'number':
        this.next();
        return token.value as number;
      case 'relative':
        // `-7d` stays symbolic — relative-date.ts resolves it at compile time.
        this.next();
        return token.text;
      case 'at':
        this.next();
        return token.value === 'me' ? ME : `@${token.value as string}`;
      case 'ident': {
        this.next();
        const lower = token.text.toLowerCase();
        if (lower === 'me') return ME;
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        return token.text;
      }
      case 'keyword':
        if (token.keyword === 'NULL') {
          this.next();
          return null;
        }
        return this.fail(token, `Unexpected ${describe(token)} — expected a value.`);
      /* The remaining kinds never appear in value position — a value follows an
         operator. Listed for exhaustiveness so a new token kind must decide
         how it becomes a value before it can reach the compiler. */
      case 'op':
      case 'lparen':
      case 'rparen':
      case 'comma':
      case 'colon':
      case 'eof':
      case 'error':
        return this.fail(token, 'Expected a value.');
    }
  }

  /**
   * Free text becomes `text contains <term>` — the same operator the visual
   * builder already has, so the AST stays closed and both backends already
   * know it. `text` is a field on the `search` resource (fields.ts); a board
   * filter that wants this gets the same tree when the board TQL box ships.
   */
  private freeText(token: Token): FilterNode {
    this.next();
    switch (token.kind) {
      case 'string':
        // The receiver accepts the raw value; a string token always decoded one.
        return compare('text', 'contains', token.value);
      case 'number':
        return compare('text', 'contains', String(token.value));
      case 'at':
        // value is the name after '@' — a string for every 'at' token.
        return compare('text', 'contains', `@${token.value as string}`);
      case 'ident':
      case 'relative':
        return compare('text', 'contains', token.text);
      /* Unreachable — parseAtom only routes ident/string/number/relative/at
         here. Listed for exhaustiveness: a new token kind must decide how it
         becomes free text before the compiler ever sees it. */
      case 'keyword':
      case 'op':
      case 'lparen':
      case 'rparen':
      case 'comma':
      case 'colon':
      case 'eof':
      case 'error':
        return this.fail(token, `Unexpected ${describe(token)} — expected free text.`);
    }
  }

  /** ORDER BY <field> [ASC|DESC]. Direction defaults to ASC. */
  parseOrderBy(): OrderBy | null {
    const token = this.peek();
    if (token.kind !== 'keyword' || token.keyword !== 'ORDER') return null;

    this.next();
    const by = this.peek();
    if (by.kind !== 'keyword' || by.keyword !== 'BY') {
      this.fail(by, 'Expected BY after ORDER.');
    }
    this.next();

    const field = this.peek();
    if (field.kind !== 'ident') {
      this.fail(field, 'Expected a field name after ORDER BY.');
    }
    this.next();

    const directionToken = this.peek();
    let direction: 'asc' | 'desc' = 'asc';
    if (directionToken.kind === 'keyword' && directionToken.keyword === 'ASC') {
      this.next();
    } else if (directionToken.kind === 'keyword' && directionToken.keyword === 'DESC') {
      direction = 'desc';
      this.next();
    }

    return { field: field.text, direction };
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'eof':
      return 'the end of the query';
    case 'string':
      return `the string ${token.text}`;
    case 'keyword':
      return `"${token.text.toUpperCase()}"`;
    /* Every remaining kind renders as its raw text — a keyword's quote style
       is the only special case, and it is handled above. */
    case 'number':
    case 'at':
    case 'ident':
    case 'relative':
    case 'op':
    case 'lparen':
    case 'rparen':
    case 'comma':
    case 'colon':
    case 'error':
      return `"${token.text}"`;
  }
}
