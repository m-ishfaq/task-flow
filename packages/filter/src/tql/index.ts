/**
 * TQL — the text frontend onto the shared filter AST (PLAN.md §10.2,
 * ai/phase-8-search.md §1).
 *
 *   Phase 3   visual builder ──► AST ──► SQL compiler      (board views)
 *   Phase 10  automation      ──► AST ──► in-memory evaluator
 *   Phase 8   TQL text ──► parser ──► AST                   (this module)
 *
 * Same tree, second frontend. `parse` produces the exact FilterNode the
 * visual builder already produces, `format` renders one back, and the
 * existing `validate`/`compile`/`evaluate` pipeline consumes the result with
 * no changes beyond accepting symbolic dates (`-7d`, `@today`) — see
 * relative-date.ts.
 */

export {
  tokenize,
  type Token,
  type TokenKind,
  type Keyword,
  type TokenizeResult,
  type LexError,
} from './tokenize.js';

export { parse, type ParseResult, type OrderBy, type TqlError } from './parse.js';

export { format } from './format.js';

export { isSymbolicDate, resolveSymbolicDate, TODAY, NOW } from './relative-date.js';
