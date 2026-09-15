import { z } from 'zod';
import type { Subject } from '@taskflow/policy';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { SearchProvider } from '@taskflow/contracts';
import * as savedSearches from './saved-search.service.js';
import type { SavedSearchActor } from './saved-search.service.js';
import { DEFAULT_LIMIT, MAX_LIMIT, performSearch } from './search.service.js';

/**
 * The search route (ai/phase-8-search.md §2.7, Phase 8 Wave 2).
 *
 * ## The floor and the real gate
 *
 * `search:query` is a MEMBERSHIP-level floor — `route()`'s `couldGrant` is
 * satisfied by any member, because an org search legitimately spans every
 * product. The REAL gate is below, per hit: the index answers "which org"
 * (RLS), never "which resources may this viewer see" — so the route loads
 * each hit's parent row and asks `can()` with the same Target the resource's
 * own routes use. A card in a board the caller cannot read is never returned,
 * even though RLS admitted the row. The result is bounded (default 50, max
 * 100), so the per-hit checks are a bounded loop, not a fan-out.
 *
 * ## The input is TQL TEXT, and the server is the only parser
 *
 * The client sends the query string the user typed; parse + validate run
 * HERE, at the trust boundary, never in the browser. Nothing user-controlled
 * reaches `compile` except through the parser, and compile re-validates
 * anyway — the same two-layer discipline every filter in this codebase uses.
 */

const TqlQuery = z.string().trim().max(1_000);

/**
 * A hit's parent context, validated on the way OUT (§2.7).
 *
 * Deliberately the same discriminated union `SearchHitMetadata` declares: the
 * provider writes these shapes, the route's per-hit `can()` reads them, and
 * this schema is what makes a wrong shape fail HERE (on the response) instead
 * of being shipped to a client that then crashes navigating with a missing
 * parent id. An untyped `z.unknown()` would validate nothing at all.
 */
const HitMetadata = z.union([
  z.object({ board_id: z.string(), project_id: z.string() }).strict(),
  z.object({ channel_id: z.string() }).strict(),
  z.object({ space_id: z.string() }).strict(),
  z.object({ card_id: z.string(), board_id: z.string() }).strict(),
  z.object({ page_id: z.string(), space_id: z.string() }).strict(),
  z.object({ recording_id: z.string(), call_id: z.string() }).strict(),
]);

function actorOf(ctx: { principal: Parameters<typeof subjectOf>[0] }): Subject {
  return subjectOf(ctx.principal);
}

/** A saved search's own name and TQL bounds — migration 0046's CHECK constraints, restated. */
const SavedSearchName = z.string().trim().min(1).max(60);

function savedSearchActorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: SavedSearchActor['requestId'];
}): SavedSearchActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createSearchRouter(provider: SearchProvider) {
  return router({
    /**
     * Saved searches (§3.2).
     *
     * Every route floors on `search:query` — if you may run a search you may
     * keep one. SHARING is the second question, asked inside the service with
     * no target so it is answered by role alone (`search:manage`); see that
     * file's §1. The floor is deliberately not raised to `search:manage`,
     * which would stop members keeping private bookmarks.
     */
    saved: router({
      list: route({ permission: 'search:query' })
        .input(z.object({}).strict())
        .output(
          z
            .array(
              z.object({
                searchId: z.string(),
                name: z.string(),
                query: z.string(),
                isShared: z.boolean(),
                createdBy: z.string(),
                broken: z.boolean(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => savedSearches.listSavedSearches(savedSearchActorOf(ctx))),

      create: route({ permission: 'search:query' })
        .input(z.object({ name: SavedSearchName, query: TqlQuery, isShared: z.boolean() }).strict())
        .output(z.object({ searchId: z.string() }))
        .mutation(({ input, ctx }) =>
          savedSearches.createSavedSearch(savedSearchActorOf(ctx), input),
        ),

      update: route({ permission: 'search:query' })
        .input(
          z
            .object({
              searchId: z.string().uuid(),
              name: SavedSearchName,
              query: TqlQuery,
              isShared: z.boolean(),
            })
            .strict(),
        )
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) =>
          savedSearches.updateSavedSearch(savedSearchActorOf(ctx), input),
        ),

      delete: route({ permission: 'search:query' })
        .input(z.object({ searchId: z.string().uuid() }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          savedSearches.deleteSavedSearch(savedSearchActorOf(ctx), input),
        ),
    }),

    /* The one route in this router that is actually expensive — a TQL
       execution scans the trigram indexes and assembles per-hit permission
       answers. The saved-search CRUD above is ordinary bookkeeping and
       counts only against the token's daily total (§6.5's expensive class). */
    query: route({ permission: 'search:query', quotaClass: 'expensive' })
      .input(
        z
          .object({
            query: TqlQuery,
            limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
          })
          .strict(),
      )
      .output(
        z
          .array(
            z.object({
              type: z.enum(['card', 'message', 'page', 'comment', 'transcript']),
              entityId: z.string(),
              title: z.string().nullable(),
              contextLabel: z.string().nullable(),
              snippet: z.string().nullable(),
              authorId: z.string().nullable(),
              updatedAt: z.string(),
              archived: z.boolean(),
              metadata: HitMetadata,
              score: z.number(),
            }),
          )
          .readonly(),
      )
      .query(({ input, ctx }) => performSearch(provider, actorOf(ctx), input)),
  });
}
