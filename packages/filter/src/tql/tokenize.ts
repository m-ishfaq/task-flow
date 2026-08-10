/**
 * TQL tokenizer (ai/phase-8-search.md §1.2).
 *
 * The first stage of `tokenize → parse → validate → compile`. Deliberately dumb
 * and deliberately resource-agnostic: it produces a positioned token stream and
 * decides nothing about which token is a field name — that is the parser's job
 * (it knows operators) and `validate`'s job (it knows fields). The split matters
 * because the tokenizer is shared by every resource's TQL, and a tokenizer that
 * "helpfully" classified `type` as a field would break the moment a second
 * resource with different fields existed.
 *
 * Every token carries `offset`/`length` into the source, and so does every error
 * token, so the UI can underline exactly the bad token — the same contract
 * `validate.ts` already keeps for the visual builder's chips.
 */

export type Keyword =
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'IN'
  | 'IS'
  | 'EMPTY'
  | 'CONTAINS'
  | 'ORDER'
  | 'BY'
  | 'ASC'
  | 'DESC'
  | 'NULL';

const KEYWORDS: Readonly<Record<string, Keyword>> = {
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  IN: 'IN',
  IS: 'IS',
  EMPTY: 'EMPTY',
  CONTAINS: 'CONTAINS',
  ORDER: 'ORDER',
  BY: 'BY',
  ASC: 'ASC',
  DESC: 'DESC',
  NULL: 'NULL',
};

export type TokenKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'relative'
  | 'at'
  | 'op'
  | 'keyword'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'colon'
  | 'eof'
  | 'error';

export interface Token {
  readonly kind: TokenKind;
  /** The raw source slice this token covers. */
  readonly text: string;
  /**
   * Decoded payload: the unescaped contents for a `string`, the numeric value
   * for a `number`, the name after `@` for an `at`, the full literal (`'-7d'`)
   * for `relative`. Undefined for the rest.
   */
  readonly value?: string | number;
  readonly keyword?: Keyword;
  readonly offset: number;
  readonly length: number;
}

/** A lexing failure, positioned for the UI. */
export interface LexError {
  readonly offset: number;
  readonly length: number;
  readonly message: string;
}

export interface TokenizeResult {
  readonly tokens: readonly Token[];
  readonly errors: readonly LexError[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

/**
 * Tokenizes a TQL query.
 *
 * Returns tokens AND errors rather than throwing, because a query with two bad
 * tokens should report both — the same "show all the problems at once" contract
 * as `validate.ts`. Callers short-circuit on `errors`; the token stream is
 * still produced for offset bookkeeping.
 */
export function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let i = 0;

  /* exactOptionalPropertyTypes: the optional fields are omitted, never set to
     undefined, so a token that carries a value and one that does not are
     distinguishable to code that checks `token.value !== undefined`. */
  const push = (
    kind: TokenKind,
    start: number,
    text: string,
    value?: string | number,
    keyword?: Keyword,
  ) => {
    const token: Token = { kind, text, offset: start, length: text.length };
    if (value !== undefined) (token as { value?: string | number }).value = value;
    if (keyword !== undefined) (token as { keyword?: Keyword }).keyword = keyword;
    tokens.push(token);
  };

  while (i < input.length) {
    const start = i;
    // charAt, not indexing: it returns "" (never undefined) out of range, so
    // the hot single-character lookups need no non-null assertions.
    const ch = input.charAt(i);

    if (SPACE.test(ch)) {
      i += 1;
      continue;
    }

    // --- operators -------------------------------------------------------
    if (ch === '=') {
      push('op', start, '=');
      i += 1;
      continue;
    }
    if (ch === '!') {
      if (input[i + 1] === '=') {
        push('op', start, '!=');
        i += 2;
      } else {
        errors.push({ offset: start, length: 1, message: `Unexpected "!". Did you mean "!="?` });
        push('error', start, '!');
        i += 1;
      }
      continue;
    }
    if (ch === '<') {
      if (input[i + 1] === '=') {
        push('op', start, '<=');
        i += 2;
      } else if (input[i + 1] === '>') {
        push('op', start, '<>');
        i += 2;
      } else {
        push('op', start, '<');
        i += 1;
      }
      continue;
    }
    if (ch === '>') {
      if (input[i + 1] === '=') {
        push('op', start, '>=');
        i += 2;
      } else {
        push('op', start, '>');
        i += 1;
      }
      continue;
    }

    // --- punctuation -------------------------------------------------------
    if (ch === '(') {
      push('lparen', start, '(');
      i += 1;
      continue;
    }
    if (ch === ')') {
      push('rparen', start, ')');
      i += 1;
      continue;
    }
    if (ch === ',') {
      push('comma', start, ',');
      i += 1;
      continue;
    }
    if (ch === ':') {
      push('colon', start, ':');
      i += 1;
      continue;
    }

    // --- signed number or relative date ------------------------------------
    // `-7d` and `+3w` are single tokens; a bare `-7` is a negative number.
    // `-`/`+` are otherwise not TQL tokens at all (there is no arithmetic).
    if (ch === '+' || ch === '-') {
      if (DIGIT.test(input[i + 1] ?? '')) {
        i = scanNumber(input, i, push, errors);
      } else {
        errors.push({ offset: start, length: 1, message: `Unexpected "${ch}".` });
        push('error', start, ch);
        i += 1;
      }
      continue;
    }

    // --- unsigned number or relative date ----------------------------------
    if (DIGIT.test(ch)) {
      i = scanNumber(input, i, push, errors);
      continue;
    }

    // --- quoted string -------------------------------------------------------
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let decoded = '';
      let closed = false;
      while (j < input.length) {
        const c = input.charAt(j);
        if (c === '\\') {
          const next = input[j + 1];
          if (next === undefined) break;
          // Only \" and \\ are defined escapes; anything else keeps its
          // backslash, so pasting Windows paths does not become an error.
          decoded += next === '"' || next === '\\' ? next : `\\${next}`;
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          j += 1;
          break;
        }
        decoded += c;
        j += 1;
      }
      if (!closed) {
        errors.push({
          offset: start,
          length: input.length - start,
          message: `Unterminated string — the closing ${quote} is missing.`,
        });
        push('error', start, input.slice(start), decoded);
        i = input.length;
        continue;
      }
      push('string', start, input.slice(start, j), decoded);
      i = j;
      continue;
    }

    // --- @values --------------------------------------------------------------
    if (ch === '@') {
      if (IDENT_START.test(input.charAt(i + 1))) {
        let j = i + 2;
        while (j < input.length && IDENT_CONT.test(input.charAt(j))) j += 1;
        const name = input.slice(i + 1, j);
        push('at', start, input.slice(i, j), name);
        i = j;
        continue;
      }
      errors.push({
        offset: start,
        length: 1,
        message: `Unexpected "@" — expected a name after it, like @me.`,
      });
      push('error', start, '@');
      i += 1;
      continue;
    }

    // --- identifiers and keywords ------------------------------------------------
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < input.length && IDENT_CONT.test(input.charAt(j))) j += 1;
      const text = input.slice(i, j);
      const keyword = KEYWORDS[text.toUpperCase()];
      push(keyword ? 'keyword' : 'ident', start, text, undefined, keyword);
      i = j;
      continue;
    }

    errors.push({ offset: start, length: 1, message: `Unexpected character "${ch}".` });
    push('error', start, ch);
    i += 1;
  }

  tokens.push({ kind: 'eof', text: '', offset: input.length, length: 0 });
  return { tokens, errors };
}

type TokenSink = (
  kind: TokenKind,
  start: number,
  text: string,
  value?: string | number,
  keyword?: Keyword,
) => void;

/**
 * Scans a signed or unsigned number, with an optional relative-date unit.
 *
 * `7`, `-7`, `3.5` are numbers; `7d`, `-2w`, `+3mo` are relative-date literals
 * (kept symbolic — see relative-date.ts). A DECIMAL followed by a unit
 * (`7.5d`) is refused: it would be a relative date with fractional days, which
 * the closed vocabulary does not include, and silently treating it as `7.5`
 * plus a stray `d` would be a worse error.
 *
 * Returns the new scan position.
 */
function scanNumber(input: string, start: number, push: TokenSink, errors: LexError[]): number {
  let j = start;
  if (input.charAt(j) === '+' || input.charAt(j) === '-') j += 1;
  while (j < input.length && DIGIT.test(input.charAt(j))) j += 1;

  let hasDecimal = false;
  if (input.charAt(j) === '.' && DIGIT.test(input.charAt(j + 1))) {
    hasDecimal = true;
    j += 1;
    while (j < input.length && DIGIT.test(input.charAt(j))) j += 1;
  }

  // `mo` is two characters — check it before the single-letter units.
  const unit = input[j];
  const isMonth = unit === 'm' && input[j + 1] === 'o';
  const isDayWeek = (unit === 'd' || unit === 'w') && !hasDecimal;

  if (isMonth || isDayWeek) {
    const end = j + (isMonth ? 2 : 1);
    const literal = input.slice(start, end);
    // value mirrors text: the parser stores the literal AS the value, so the
    // symbolic form (`-7d`) is what the AST carries, unresolved (relative-date.ts).
    push('relative', start, literal, literal);
    return end;
  }

  if (hasDecimal && unit !== undefined && /[A-Za-z]/.test(unit)) {
    errors.push({
      offset: start,
      length: j - start,
      message: `"${input.slice(start, j)}" cannot be followed by a unit — relative dates are whole days, weeks or months.`,
    });
    push('error', start, input.slice(start, j));
    return j;
  }

  const text = input.slice(start, j);
  push('number', start, text, Number(text));
  return j;
}
