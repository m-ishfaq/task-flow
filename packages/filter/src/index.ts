/**
 * @taskflow/filter — the filter AST, its validator, and two backends
 * (PLAN.md §10.2).
 *
 * One tree, three frontends and two backends:
 *
 *   Phase 3   visual builder ──► AST ──► SQL compiler   (board / table views)
 *   Phase 10  automation      ──► AST ──► evaluator     (rule conditions)
 *   Phase 8   TQL text ──► parser ──► AST               (same tree, later)
 *
 * Building ILIKE search now and TQL later would mean writing filtering twice
 * and discarding one. This is the half that is needed immediately.
 *
 * The security control is `fields.ts`: no user string ever reaches the database
 * as a field name or an operator. Values are always parameterized.
 */

export {
  FilterTree,
  FilterValue,
  OPERATORS,
  NULLARY_OPERATORS,
  LIST_OPERATORS,
  ME,
  MAX_DEPTH,
  MAX_NODES,
  MAX_LIST_LENGTH,
  compare,
  and,
  or,
  not,
  type FilterNode,
  type ComparisonNode,
  type GroupNode,
  type NotNode,
  type Operator,
} from './ast.js';

export {
  FIELD_SETS,
  OPERATORS_BY_TYPE,
  findField,
  fieldsOf,
  operatorsFor,
  supportsOperator,
  resourceForTrigger,
  type FieldDefinition,
  type FieldType,
  type Resource,
} from './fields.js';

export { validate, type FilterError, type ValidationResult } from './validate.js';

export {
  compile,
  FilterCompileError,
  type CompiledFilter,
  type CompileOptions,
} from './compile.js';

export { evaluate, type EvaluableRow, type EvaluateOptions } from './evaluate.js';

export {
  parse,
  format,
  tokenize,
  isSymbolicDate,
  resolveSymbolicDate,
  TODAY,
  NOW,
  type ParseResult,
  type OrderBy,
  type TqlError,
  type Token,
  type TokenKind,
  type Keyword,
  type TokenizeResult,
  type LexError,
} from './tql/index.js';
