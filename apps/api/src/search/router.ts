import { z } from 'zod';
import { errors, unsafeAsId, type OrgId } from '@taskflow/contracts';
import { parse, validate, type ParseResult } from '@taskflow/filter';
import { can, type Subject } from '@taskflow/policy';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { loadChannel, channelTarget } from '../chat/shared.js';
import { loadPage, pageTarget } from '../docs/shared.js';
import { loadCard } from '../work/card.service.js';
import type { SearchProvider, SearchHit } from '@taskflow/contracts';
import { withOrgScope } from '@taskflow/db';

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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const TqlQuery = z.string().trim().max(1_000);

function actorOf(ctx: { principal: Parameters<typeof subjectOf>[0] }): Subject {
  return subjectOf(ctx.principal);
}

interface ParsedQuery {
  readonly filter: Extract<ParseResult, { readonly ok: true }>['filter'];
  readonly orderBy: Extract<ParseResult, { readonly ok: true }>['orderBy'];
}

/**
 * Refuses a query that did not parse or does not validate, with the parser's
 * own positioned messages — the UI can underline the bad token.
 */
function parseQuery(query: string): ParsedQuery {
  const parsed = parse(query);
  if (!parsed.ok) {
    throw errors.validation(
      { query: parsed.errors.map((error) => error.message) },
      'That search query could not be parsed.',
    );
  }

  if (parsed.filter !== null) {
    const result = validate('search', parsed.filter);
    if (!result.ok) {
      throw errors.validation(
        { query: result.errors.map((error) => error.message) },
        'That search query is not valid.',
      );
    }
  }

  return { filter: parsed.filter, orderBy: parsed.orderBy };
}

/** Loads a hit's parent row and asks the real authorization question. */
async function hitAllowed(subject: Subject, orgId: OrgId, hit: SearchHit): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    try {
      switch (hit.type) {
        case 'card': {
          const card = await loadCard(tx, unsafeAsId<'CardId'>(hit.entityId));
          return can(subject, 'card:read', {
            // The loaded row's orgId is a plain string by design; the target
            // needs the branded id, constructed at this trust boundary.
            orgId: unsafeAsId<'OrgId'>(card.orgId),
            // The hit's entity id IS the card id — the loaded row confirms the
            // card exists and supplies the ancestors; `resource` names the
            // row the hit represents.
            resource: { type: 'card', id: hit.entityId },
            ancestors: [
              { type: 'board', id: card.boardId },
              { type: 'project', id: card.projectId },
            ],
          }).allowed;
        }

        case 'message': {
          const meta = hit.metadata as { readonly channel_id: string };
          const channel = await loadChannel(tx, unsafeAsId<'ChannelId'>(meta.channel_id));
          return can(subject, 'channel:read', channelTarget(channel)).allowed;
        }

        case 'page': {
          const page = await loadPage(tx, unsafeAsId<'PageId'>(hit.entityId));
          return can(subject, 'page:read', pageTarget(page)).allowed;
        }

        case 'comment': {
          const meta = hit.metadata as
            { readonly card_id: string; readonly board_id: string } | { readonly page_id: string };
          if ('page_id' in meta) {
            const page = await loadPage(tx, unsafeAsId<'PageId'>(meta.page_id));
            return can(subject, 'page:read', pageTarget(page)).allowed;
          }
          const card = await loadCard(tx, unsafeAsId<'CardId'>(meta.card_id));
          return can(subject, 'card:read', {
            orgId: unsafeAsId<'OrgId'>(card.orgId),
            resource: { type: 'card', id: meta.card_id },
            ancestors: [
              { type: 'board', id: card.boardId },
              { type: 'project', id: card.projectId },
            ],
          }).allowed;
        }

        default:
          // A hit type the build does not know (a transcript, added in Wave 3)
          // is not shown — fail closed rather than guessing its permission.
          return false;
      }
    } catch (error) {
      /* A parent row that is gone (hard-deleted since indexing) means the hit
         is stale — drop it, don't 500 the whole query. `loadChannel`/`loadPage`
         throw NOT_FOUND for a row RLS erased too, which is exactly the "RLS
         admitted the row but the resource is not this caller's" case §2.7
         describes. Only NOT_FOUND is swallowed; anything else propagates. */
      if (isNotFound(error)) return false;
      throw error;
    }
  });
}

/** True when `error` is the contracts NOT_FOUND AppError. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'NOT_FOUND'
  );
}

export function createSearchRouter(provider: SearchProvider) {
  return router({
    query: route({ permission: 'search:query' })
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
              type: z.enum(['card', 'message', 'page', 'comment']),
              entityId: z.string(),
              title: z.string().nullable(),
              snippet: z.string().nullable(),
              authorId: z.string().nullable(),
              updatedAt: z.string(),
              archived: z.boolean(),
              metadata: z.unknown(),
              score: z.number(),
            }),
          )
          .readonly(),
      )
      .query(async ({ input, ctx }) => {
        const subject = actorOf(ctx);
        const { filter, orderBy } = parseQuery(input.query);

        // An empty query is "no constraint" — return nothing, not everything.
        if (filter === null) return [];

        const hits = await provider.search({
          orgId: subject.orgId,
          filter,
          orderBy: orderBy === null ? [] : [orderBy],
          viewerId: subject.userId,
          limit: input.limit,
        });

        const allowed: SearchHit[] = [];
        for (const hit of hits) {
          if (await hitAllowed(subject, subject.orgId, hit)) allowed.push(hit);
        }
        return allowed;
      }),
  });
}
