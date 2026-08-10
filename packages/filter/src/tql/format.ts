/**
 * TQL formatter (ai/phase-8-search.md §1.4).
 *
 * The other half of §10.2's promise: *"Dragging a filter chip regenerates the
 * TQL text; editing the text reparses into chips."* This renders a FilterNode
 * back to canonical TQL, so the visual builder teaches the language by
 * construction.
 *
 * ## The round-trip contract
 *
 * `parse(format(node))` must equal `node` for every tree in the canonical
 * class: comparisons, NOT, and groups with TWO OR MORE children. The
 * exceptions are structural and documented rather than papered over:
 *
 * - A group with one child or zero children has no TQL that says "this is an
 *   OR group with one member" — `(a)` re-parses as an AND group around `a`.
 *   Single-child and empty groups are semantically the identity element of
 *   their combinator, no builder ever constructs them, and the property test
 *   excludes them for that reason.
 * - Resolved dates render as their ISO strings; the relative form is gone once
 *   compile() resolved it (relative-date.ts says why that is honest).
 *
 * The formatter emits parens around every group, matching compile.ts, and
 * strings are quoted exactly when a bare rendering would re-parse to a
 * different VALUE — the `me`/`true`/keyword cases — so the round trip is
 * value-exact, not just syntactically valid.
 */

import { ME, type ComparisonNode, type FilterNode, type FilterValue } from '../ast.js';

/** Bare words that would re-parse as something other than the literal string. */
const RESERVED = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'empty',
  'contains',
  'order',
  'by',
  'asc',
  'desc',
  'null',
  'me',
  'true',
  'false',
]);

/** Renders a tree as canonical TQL. Null — "no constraint" — is the empty string. */
export function format(node: FilterNode | null): string {
  if (node === null) return '';
  return emit(node);
}

function emit(node: FilterNode): string {
  if (node.kind === 'group') {
    if (node.children.length === 0) return '()';
    const joiner = node.combinator === 'and' ? ' AND ' : ' OR ';
    return `(${node.children.map(emit).join(joiner)})`;
  }

  if (node.kind === 'not') {
    // emit() of a group already parenthesizes it, so `NOT (a OR b)` comes out
    // right and a bare `NOT a = b` stays bare — the parse of each re-produces
    // the same tree shape.
    return `NOT ${emit(node.child)}`;
  }

  return emitComparison(node);
}

function emitComparison(node: ComparisonNode): string {
  const { field, operator } = node;
  switch (operator) {
    case 'eq':
      return `${field} = ${emitValue(node.value as FilterValue)}`;
    case 'neq':
      return `${field} != ${emitValue(node.value as FilterValue)}`;
    case 'lt':
      return `${field} < ${emitValue(node.value as FilterValue)}`;
    case 'lte':
      return `${field} <= ${emitValue(node.value as FilterValue)}`;
    case 'gt':
      return `${field} > ${emitValue(node.value as FilterValue)}`;
    case 'gte':
      return `${field} >= ${emitValue(node.value as FilterValue)}`;
    case 'in':
      return `${field} IN (${(node.value as readonly FilterValue[]).map(emitValue).join(', ')})`;
    case 'not_in':
      return `${field} NOT IN (${(node.value as readonly FilterValue[]).map(emitValue).join(', ')})`;
    case 'contains':
      return `${field} CONTAINS ${emitValue(node.value as FilterValue)}`;
    case 'is_empty':
      return `${field} IS EMPTY`;
    case 'is_not_empty':
      return `${field} IS NOT EMPTY`;
    default:
      // Unreachable while OPERATORS and this switch agree (exhaustiveness is
      // lint-checked). A new operator without a textual form must fail a build,
      // not round-trip as something silently different.
      return '';
  }
}

function emitValue(value: FilterValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);

  if (value === ME) return '@me';
  return isSafeBare(value) ? value : quote(value);
}

/** True when `value` re-parses to the identical string in value position. */
function isSafeBare(value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false;
  return !RESERVED.has(value.toLowerCase());
}

/** Double-quoted with escaping — the only quoting the tokenizer defines. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
