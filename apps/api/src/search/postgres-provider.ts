import { asc, compiledPredicate, desc, schema, withOrgScope, type SQL } from '@taskflow/db';
import { compile, findField, type FilterNode, type OrderBy } from '@taskflow/filter';
import {
  type SearchHit,
  type SearchProvider,
  type SearchQuery,
  type SearchHitMetadata,
} from '@taskflow/contracts';

/**
 * The Postgres full-text implementation of `SearchProvider`
 * (ai/phase-8-search.md §2.6, Phase 8 Wave 2).
 *
 * The whole point of the interface being declared over the TQL-compiled AST:
 * this provider translates the SAME tree the future Meilisearch one will, so
 * "switch when past ~200k indexed rows" is a provider swap, not a rewrite of
 * the route. Everything below is the Postgres rendering of a tree that is
 * already validated and compiled by `@taskflow/filter`.
 *
 * ## What it does NOT do
 *
 * Authorization. `viewerId` resolves `@me` in the tree (`author = @me`) — the
 * same reason `compile()` takes it — and nothing else. The ROUTE performs
 * per-hit `can()` on every returned row (§2.7), because the index answers
 * "which org" (RLS) and the policy engine answers "which resources may THIS
 * viewer see". A provider that filtered by viewer would be a second, drifting
 * copy of the authorization model.
 */

/** The concatenation expression migration 0045's two GIN indexes are built over. */
function textConcat(): string {
  const text = findField('search', 'text');
  /* Unreachable — the `text` field set is a literal in fields.ts. Thrown rather
     than interpolated so a future edit that renames the field fails here at
     boot, not as a syntax error in a query string.

     `sql === null` marks an evaluator-only field (§7.8b's connector set). No
     search field is one, and a search field that became one would produce
     `to_tsvector('english', null)` — a query that runs and matches nothing. */
  if (text?.sql == null) throw new Error('search field set lost its `text` field');
  return text.sql;
}

/**
 * The first free-text term in the tree, if any.
 *
 * A `text contains "term"` comparison is what makes a query a SEARCH rather
 * than a filter. The provider uses it twice: it is already IN the compiled
 * WHERE (via ILIKE over the concatenation, matched by the trgm GIN index),
 * and it is what this returns so ts_rank can order by actual relevance.
 * Only the FIRST term ranks — a query with two free-text terms is rare, and
 * ranking by the first is honest where a made-up combined score would not be.
 */
function freeTextTerm(node: FilterNode | null): string | null {
  if (node === null) return null;

  if (node.kind === 'comparison') {
    if (node.field === 'text' && node.operator === 'contains') {
      /* `contains` takes a scalar (never a list — the AST schema enforces it)
         and the search `text` field is type `text`, so a non-string value is
         already rejected by validate; anything else arriving here is no term. */
      return typeof node.value === 'string' ? node.value : null;
    }
    return null;
  }

  if (node.kind === 'not') return freeTextTerm(node.child);

  for (const child of node.children) {
    const term = freeTextTerm(child);
    if (term !== null) return term;
  }
  return null;
}

/** The ts_rank expression for `term`, over the indexed concatenation. */
function rankExpression(term: string): SQL {
  return compiledPredicate(
    `ts_rank_cd(to_tsvector('english', ${textConcat()}), plainto_tsquery('english', $1))`,
    [term],
  );
}

/**
 * The ORDER BY list.
 *
 * An explicit `ORDER BY` (from the TQL text) wins, mapped through the field
 * whitelist so a sort key is a column expression, never input text. Without
 * one, free text orders by ts_rank with `updated_at` as the tiebreak; a pure
 * filter query orders by `updated_at` alone.
 */
function buildOrderBy(orderBy: readonly OrderBy[], filter: FilterNode | null): readonly SQL[] {
  if (orderBy.length > 0) {
    return orderBy.map((entry) => {
      const field = findField('search', entry.field);
      /* The route validates orderBy fields before calling; this is the second
         half of that argument — the provider re-checks rather than trusting
         its caller, the identical discipline compile() applies to trees. */
      if (field?.sql == null) {
        throw new Error(`Unknown ORDER BY field "${entry.field}".`);
      }
      const column = compiledPredicate(field.sql, []);
      return entry.direction === 'asc' ? asc(column) : desc(column);
    });
  }

  const term = freeTextTerm(filter);
  if (term !== null) {
    return [desc(rankExpression(term)), desc(schema.documents.updatedAt)];
  }

  return [desc(schema.documents.updatedAt)];
}

/**
 * Builds the excerpt for a hit.
 *
 * A window around the first match of `term` in the body (or title when the
 * body is NULL — a page indexed title-only, §2.4), so the palette can show
 * "…the matched term in context…" rather than a bare string. Highlighting is
 * the CLIENT's job — it has the term, and markup in a server response is the
 * XSS shape this codebase refuses (§8.7). Null when nothing matches, which
 * the client renders as title-only.
 */
function excerptOf(body: string | null, title: string | null, term: string | null): string | null {
  const haystack = body ?? title;
  if (haystack === null) return null;

  if (term === null) {
    // Pure filter query — no term to anchor an excerpt on. A short prefix is
    // better than nothing when the title is itself NULL (a message).
    return haystack.length > 160 ? `${haystack.slice(0, 157)}…` : haystack;
  }

  const index = haystack.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return null;

  const start = Math.max(0, index - 60);
  const end = Math.min(haystack.length, index + term.length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < haystack.length ? '…' : '';
  return `${prefix}${haystack.slice(start, end)}${suffix}`;
}

/** Maps a raw documents row to the wire `SearchHit`. */
function toHit(
  row: {
    readonly entityType: string;
    readonly entityId: string;
    readonly title: string | null;
    readonly body: string | null;
    readonly authorId: string | null;
    readonly updatedAt: Date;
    readonly archived: boolean;
    readonly metadata: unknown;
    readonly score: unknown;
  },
  term: string | null,
): SearchHit {
  return {
    type: row.entityType as SearchHit['type'],
    entityId: row.entityId,
    title: row.title,
    snippet: excerptOf(row.body, row.title, term),
    authorId: row.authorId,
    updatedAt: row.updatedAt.toISOString(),
    archived: row.archived,
    metadata: row.metadata as SearchHitMetadata,
    /* A raw `tx.select` column is untyped by construction (the driver hands
       back whatever Postgres rendered); ts_rank_cd is a float, so Number() is
       the honest narrowing. */
    score: Number(row.score),
  };
}

export class PostgresSearchProvider implements SearchProvider {
  async search(query: SearchQuery): Promise<readonly SearchHit[]> {
    const compiled = compile('search', query.filter, { viewerId: query.viewerId });
    const term = freeTextTerm(query.filter);

    const rank = term === null ? compiledPredicate('0', []) : rankExpression(term);
    const orderBy = buildOrderBy(query.orderBy, query.filter);

    return withOrgScope(query.orgId, async (tx) => {
      const rows = await tx
        .select({
          entityType: schema.documents.entityType,
          entityId: schema.documents.entityId,
          title: schema.documents.title,
          body: schema.documents.body,
          authorId: schema.documents.authorId,
          updatedAt: schema.documents.updatedAt,
          archived: schema.documents.archived,
          metadata: schema.documents.metadata,
          score: rank,
        })
        .from(schema.documents)
        .where(compiledPredicate(compiled.sql, compiled.params))
        .orderBy(...orderBy)
        .limit(query.limit);

      return rows.map((row) => toHit(row, term));
    });
  }
}
