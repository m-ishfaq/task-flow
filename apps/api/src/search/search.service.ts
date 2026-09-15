import { errors, unsafeAsId, type OrgId } from '@taskflow/contracts';
import { parse, validate, type ParseResult } from '@taskflow/filter';
import { can, type Subject } from '@taskflow/policy';
import { and, eq, inArray, schema, withOrgScope } from '@taskflow/db';
import type { SearchProvider, SearchHit } from '@taskflow/contracts';
import { loadChannel, channelTarget } from '../chat/shared.js';
import { loadPage, pageTarget } from '../docs/shared.js';
import { loadCard } from '../work/card.service.js';
import { channelMemberIds } from '../chat/membership.js';

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

  /* ── context-label enrichment ────────────────────────────────────────
   *
   * Hits like `message`, `comment`, and `transcript` always have `title:
   * null` in the search index — they are child rows without a name of
   * their own.  The UI falls back to the bare type label ("message"),
   * which is not helpful.
   *
   * This pass batch-loads the PARENT name for every hit type that needs
   * one — channel names for messages, card titles for card comments,
   * page titles for docs comments, call summaries for transcripts — in a
   * single `withOrgScope` transaction, and writes the result into each
   * hit's `contextLabel`.  Cards and pages already carry their own title
   * in the index, so they get `null` (no enrichment needed).
   * ─────────────────────────────────────────────────────────────────── */
  if (allowed.length > 0) {
    const enriched = await resolveContextLabels(subject.orgId, subject.userId, allowed);
    return enriched;
  }

  return allowed;
}

/**
 * Batch-resolves human-readable context labels for search hits whose
 * `title` is null (messages, comments, transcripts).
 *
 * Runs in a single `withOrgScope` transaction so the per-hit resolution
 * cost is O(1) round-trips, not O(n) — each table is queried once with
 * an `IN` clause covering every hit of that type.
 */
async function resolveContextLabels(
  orgId: OrgId,
  viewerId: string,
  hits: readonly SearchHit[],
): Promise<readonly SearchHit[]> {
  return withOrgScope(orgId, async (tx) => {
    // ── Collect IDs by type ──────────────────────────────────────────
    const channelIds = new Set<string>();
    const cardIds = new Set<string>();
    const pageIds = new Set<string>();
    const callIds = new Set<string>();

    for (const hit of hits) {
      switch (hit.type) {
        case 'message': {
          const meta = hit.metadata as { readonly channel_id: string };
          channelIds.add(meta.channel_id);
          break;
        }
        case 'comment': {
          const meta = hit.metadata;
          if ('card_id' in meta) cardIds.add(meta.card_id);
          if ('page_id' in meta) pageIds.add(meta.page_id);
          break;
        }
        case 'transcript': {
          const meta = hit.metadata as { readonly call_id: string };
          if (meta.call_id) callIds.add(meta.call_id);
          break;
        }
        case 'card':
        case 'page':
          // Already carry their own title in the index — no enrichment needed.
          break;
      }
    }

    // ── Batch-load channel names + DM member names ───────────────────
    const channelNameMap = new Map<string, string>();
    const dmMemberMap = new Map<string, string[]>(); // channelId → [displayName, ...]

    if (channelIds.size > 0) {
      const ids = [...channelIds];
      const channels = await tx
        .select({ id: schema.channels.id, name: schema.channels.name, type: schema.channels.type })
        .from(schema.channels)
        .where(inArray(schema.channels.id, ids));

      // Named channels (public, private, named group DMs)
      for (const ch of channels) {
        if (ch.name) channelNameMap.set(ch.id, ch.name);
      }

      // DMs (type = 'dm', name = null) — resolve member display names
      const dmChannelIds = channels
        .filter((ch) => ch.type === 'dm' && ch.name === null)
        .map((ch) => ch.id);

      for (const dmId of dmChannelIds) {
        const memberIds = await channelMemberIds(tx, unsafeAsId<'ChannelId'>(dmId));
        if (memberIds.length === 0) continue;

        // Exclude the searching user from the label — "with Alice", not "with you"
        const otherMemberIds = memberIds.filter((id) => id !== viewerId);
        const displayIds = otherMemberIds.length > 0 ? otherMemberIds : memberIds;

        const members = await tx
          .select({
            userId: schema.memberships.userId,
            displayName: schema.users.displayName,
          })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
          .where(
            and(
              eq(schema.memberships.orgId, orgId),
              inArray(schema.memberships.userId, displayIds),
            ),
          );

        const names = members
          .map((m) => m.displayName ?? 'Someone')
          .filter(Boolean);
        if (names.length > 0) dmMemberMap.set(dmId, names);
      }
    }

    // ── Batch-load card titles ───────────────────────────────────────
    const cardTitleMap = new Map<string, { title: string; number: number }>();

    if (cardIds.size > 0) {
      const cards = await tx
        .select({ id: schema.cards.id, title: schema.cards.title, number: schema.cards.number })
        .from(schema.cards)
        .where(inArray(schema.cards.id, [...cardIds]));

      for (const card of cards) {
        cardTitleMap.set(card.id, { title: card.title, number: card.number });
      }
    }

    // ── Batch-load page titles ───────────────────────────────────────
    const pageTitleMap = new Map<string, string>();

    if (pageIds.size > 0) {
      const pages = await tx
        .select({ id: schema.pages.id, title: schema.pages.title })
        .from(schema.pages)
        .where(inArray(schema.pages.id, [...pageIds]));

      for (const page of pages) {
        pageTitleMap.set(page.id, page.title);
      }
    }

    // ── Batch-load call summaries ────────────────────────────────────
    const callSummaryMap = new Map<string, string>();

    if (callIds.size > 0) {
      const calls = await tx
        .select({
          id: schema.calls.id,
          direction: schema.calls.direction,
          durationSeconds: schema.calls.durationSeconds,
        })
        .from(schema.calls)
        .where(inArray(schema.calls.id, [...callIds]));

      for (const call of calls) {
        const dir = call.direction === 'inbound' ? 'Inbound' : 'Outbound';
        if (call.durationSeconds != null) {
          const mins = Math.floor(call.durationSeconds / 60);
          const secs = call.durationSeconds % 60;
          callSummaryMap.set(call.id, `${dir} · ${String(mins)}m ${String(secs)}s`);
        } else {
          callSummaryMap.set(call.id, dir);
        }
      }
    }

    // ── Attach labels to hits ────────────────────────────────────────
    return hits.map((hit) => {
      let contextLabel: string | null = null;

      switch (hit.type) {
        case 'message': {
          const meta = hit.metadata as { readonly channel_id: string };
          const channelName = channelNameMap.get(meta.channel_id);
          const dmNames = dmMemberMap.get(meta.channel_id);
          if (channelName) {
            contextLabel = `#${channelName}`;
          } else if (dmNames) {
            contextLabel = `DM with ${dmNames.join(', ')}`;
          }
          break;
        }
        case 'comment': {
          const meta = hit.metadata;
          if ('card_id' in meta) {
            const card = cardTitleMap.get(meta.card_id);
            if (card) contextLabel = `on #${String(card.number)} ${card.title}`;
          }
          if ('page_id' in meta) {
            const pageTitle = pageTitleMap.get(meta.page_id);
            if (pageTitle) contextLabel = `on ${pageTitle}`;
          }
          break;
        }
        case 'transcript': {
          const meta = hit.metadata as { readonly call_id: string };
          const summary = callSummaryMap.get(meta.call_id);
          if (summary) contextLabel = summary;
          break;
        }
        case 'card':
        case 'page':
          // Already carry their own title — no contextLabel needed.
          break;
      }

      return { ...hit, contextLabel };
    });
  });
}
