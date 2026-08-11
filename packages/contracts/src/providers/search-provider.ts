import type { FilterNode, OrderBy } from '@taskflow/filter';
import type { OrgId, UserId } from '../ids.js';

/**
 * The search provider (ai/phase-8-search.md §2.6, Phase 8 Wave 2).
 *
 * Deferred since Phase 3's §5 wrote the deferred-interfaces list, because an
 * interface designed without a consumer is a guess. Phase 8 is the consumer:
 * the command palette needs one query over cards, messages, pages and
 * comments, and Postgres FTS is the free implementation while Meilisearch is
 * the documented upgrade path ("switch when past ~200k indexed rows or fuzzy
 * quality complaints").
 *
 * ## Why the interface speaks AST, not SQL and not Meilisearch's query language
 *
 * Both the Postgres implementation and the future Meilisearch one translate
 * from the SAME tree — PLAN.md §10.2's "same tree" discipline extended to the
 * provider boundary. A filter tree arriving from the TQL parser or the visual
 * builder needs no translation at the API boundary; only the provider renders
 * it into its own backend's terms. Declaring it over SQL would pin the
 * interface to Postgres, and declaring it over Meilisearch's language would
 * pin it to Meilisearch.
 *
 * ## What the provider does NOT do
 *
 * `viewerId` is passed because the provider must resolve `@me` in a tree
 * (`author = @me`) against the actual caller — the same reason `compile()`
 * takes `options.now` and the evaluator takes a subject. It is NOT an
 * authorization input: the ROUTE performs per-hit `can()` on every returned
 * row (§2.7), because the index can only answer "which org", never "which
 * resource may this viewer see". RLS answers tenancy; the policy engine
 * answers the rest.
 */
export interface SearchProvider {
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
}

export interface SearchQuery {
  readonly orgId: OrgId;
  /** The TQL-compiled tree — never raw user text. */
  readonly filter: FilterNode;
  /** `ORDER BY` clauses, returned separately from the tree by the TQL parser. */
  readonly orderBy: readonly OrderBy[];
  /** Resolves `@me`; not an authorization input (see above). */
  readonly viewerId: UserId;
  /** Upper bound on rows the provider examines (default 50, max 100, §2.7). */
  readonly limit: number;
}

/** The closed set of indexed entity kinds — migration 0045's CHECK, widened by 0046. */
export type SearchEntityType = 'card' | 'message' | 'page' | 'comment' | 'transcript';

/**
 * The parent context a hit's permalink and its per-hit authorization need.
 *
 * Kept as a discriminated union rather than a loose jsonb shape so the route
 * can build the exact resource Target and the client can navigate without
 * re-deriving authorization.
 */
/* Keys are snake_case to match the jsonb the indexer stores (migration 0045's
   own comment) — the route reads `metadata->>'board_id'` through the same
   shape it writes, so there is exactly one spelling to keep in sync. */
export type SearchHitMetadata =
  | { readonly board_id: string; readonly project_id: string }
  | { readonly channel_id: string }
  | { readonly space_id: string }
  | { readonly card_id: string; readonly board_id: string }
  /* A page comment carries the SPACE too — the docs permalink renders the
     tree from `space` before it opens `page`, so { page_id } alone could
     not build one (migration 0045's metadata contract, and the indexer's
     own header on why the space id is re-read from the page row). */
  | { readonly page_id: string; readonly space_id: string }
  /* A transcript (Wave 3). The CALL is what the permalink opens — the
     telephony UI has no transcript route of its own, it renders a transcript
     inside its call detail — and the recording id is what
     `telephony.recordings.transcript` is keyed by, so both are carried.
     Neither is a phone number: 0033 stores counterparties as a blind index
     precisely so a number never sits in a readable column, and this
     projection does not become the exception. */
  | { readonly recording_id: string; readonly call_id: string };

export interface SearchHit {
  readonly type: SearchEntityType;
  /** The source row's id — the permalink's last segment. */
  readonly entityId: string;
  readonly title: string | null;
  /** Matched-term excerpt; absent when the hit matched on title only. */
  readonly snippet: string | null;
  readonly authorId: string | null;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly metadata: SearchHitMetadata;
  /**
   * The provider's own relevance (ts_rank, or similarity for prefix fuzz).
   * The client sorts by it when the user asked for no explicit ORDER BY; the
   * server never trusts a client-supplied score.
   */
  readonly score: number;
}
