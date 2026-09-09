import { errors, unsafeAsId, type OrgId } from '@taskflow/contracts';
import { parse, validate, type ParseResult } from '@taskflow/filter';
import { can, type Subject } from '@taskflow/policy';
import { eq, schema, withOrgScope } from '@taskflow/db';
import type { SearchProvider, SearchHit } from '@taskflow/contracts';
import { loadChannel, channelTarget } from '../chat/shared.js';
import { loadPage, pageTarget } from '../docs/shared.js';
import { loadCard } from '../work/card.service.js';

/**
 * The authorized search pipeline (ai/phase-8-search.md §2.7) — extracted out
 * of `router.ts` so `search.router.ts`'s tRPC route and the AI assistant's
 * `search` tool (Phase 15 §4.1) call the exact same code, rather than the
 * tool reimplementing the per-hit `can()` loop this file exists to get
 * right. See `router.ts`'s own header for why the per-hit check, not the
 * `search:query` floor, is the real gate.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

interface ParsedQuery {
  readonly filter: Extract<ParseResult, { readonly ok: true }>['filter'];
  readonly orderBy: Extract<ParseResult, { readonly ok: true }>['orderBy'];
}

/**
 * Refuses a query that did not parse or does not validate, with the parser's
 * own positioned messages — the UI can underline the bad token.
 */
export function parseQuery(query: string): ParsedQuery {
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

/** True when `error` is the contracts NOT_FOUND AppError. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'NOT_FOUND'
  );
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
          const meta = hit.metadata;
          if ('page_id' in meta) {
            const page = await loadPage(tx, unsafeAsId<'PageId'>(meta.page_id));
            return can(subject, 'page:read', pageTarget(page)).allowed;
          }
          /* A card comment. The `'card_id' in meta` check is what tells it
             apart from every other metadata shape after the page branch was
             taken — without it, `meta.card_id` is a claim about a union TS
             cannot prove. */
          if (!('card_id' in meta)) return false;
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

        case 'transcript': {
          /* The ONE hit kind whose permission is not resolved from a parent
             row, and deliberately so: `getTranscript` asks for
             `recording:read` with NO target — Admin-and-Owner by role alone,
             because "may see that a call happened" and "may read what was
             said" are two questions (transcript.service.ts's own header). A
             target here would invent a per-resource question the telephony
             surface does not ask, and search must never be the cheaper door.

             `can()` with no target answers from ROLE ALONE, which is exactly
             the semantics wanted — and is the same property that silently
             refused every guest on every chat route in Phase 5 when it was
             used by accident. Here it is the intent, not the accident. */
          if (!can(subject, 'recording:read').allowed) return false;

          /* Existence is still checked, and not as a permission: a transcript
             whose row is gone (its recording deleted, cascading) leaves a
             document behind, because the cascade emits no event for the
             indexer to consume. This read under RLS is what drops it. */
          const rows = await tx
            .select({ id: schema.transcripts.id })
            .from(schema.transcripts)
            .where(eq(schema.transcripts.id, hit.entityId))
            .limit(1);
          return rows.length > 0;
        }

        default:
          // A hit type this build does not know is not shown — fail closed
          // rather than guessing its permission.
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

/**
 * Runs a TQL query and returns only the hits `subject` may actually see.
 *
 * An empty query (no filter — the whole string was whitespace or symbolic
 * noise the parser reduced to nothing) returns nothing, not everything.
 */
export async function performSearch(
  provider: SearchProvider,
  subject: Subject,
  input: { readonly query: string; readonly limit: number },
): Promise<readonly SearchHit[]> {
  const { filter, orderBy } = parseQuery(input.query);
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
}
