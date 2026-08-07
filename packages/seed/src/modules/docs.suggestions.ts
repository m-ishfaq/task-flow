import * as Y from 'yjs';
import { createEvent } from '@taskflow/events';
import { pageSuggestionCreated, pageSuggestionDecided } from '@taskflow/api/events/docs';
import { commentDocument } from '../corpus.js';
import type { Rng } from '../rng.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { contentModule } from './docs.content.js';
import { membershipsWith, spacesModule, type SeededPage } from './docs.spaces.js';

/**
 * Suggestions — tracked-change-style proposed edits (Phase 6, Wave 3).
 *
 * ## Two authorization tiers, two membership pools — mirroring the service
 *
 * `suggestion.service.ts`'s own header: PROPOSING is `comment:create`'s tier
 * (a reviewer with no edit rights can still suggest wording), DECIDING is
 * `page:update`'s (accepting a suggestion is functionally an edit, so only
 * someone who could make that edit directly may approve someone else's). The
 * author and decider are drawn from two DIFFERENT `membershipsWith` pools
 * below for exactly that reason — collapsing them to one pool would let a
 * comment-tier account decide its own proposal in the fixture, which the real
 * service refuses.
 *
 * ## Anchors, same discipline as `docs.comments`
 *
 * See that module's own header — every anchor here is a real
 * `Y.RelativePosition`, built against a `Y.XmlText` `docs.content` actually
 * constructed for the page, never a placeholder.
 */

export interface SuggestionOutput {
  readonly suggestionRows: number;
  readonly decidedRows: number;
}

const KINDS = ['insert', 'delete', 'replace'] as const;

function randomIndex(rng: Rng, text: Y.XmlText): number {
  return rng.int(0, text.length);
}

function encodeAnchor(type: Y.XmlText, index: number): Buffer {
  return Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index)));
}

export const suggestionsModule = defineSeedModule({
  name: 'docs.suggestions',
  requires: [spacesModule, contentModule],
  tables: ['docs.suggestions'],

  async seed(ctx): Promise<SuggestionOutput> {
    const rng = ctx.rng.fork('docs.suggestions');
    const { pages } = ctx.use(spacesModule);
    const { pages: content } = ctx.use(contentModule);
    const mix = ctx.profile.page;

    const pagesById = new Map<string, SeededPage>(pages.map((page) => [page.id, page]));

    const byOrg = new Map<string, string[]>();
    for (const pageId of content.keys()) {
      const page = pagesById.get(pageId);
      if (page === undefined) continue;
      const list = byOrg.get(page.orgId) ?? [];
      list.push(pageId);
      byOrg.set(page.orgId, list);
    }

    let suggestionRows = 0;
    let decidedRows = 0;

    for (const [orgId, pageIds] of byOrg) {
      const rows: unknown[][] = [];
      const org = pagesById.get(pageIds[0] ?? '')?.space.org;
      if (org === undefined) continue;

      const authors = membershipsWith(org, 'comment:create');
      const deciders = membershipsWith(org, 'page:update');
      if (authors.length === 0) continue;

      for (const pageId of pageIds) {
        if (!rng.chance(mix.suggestionRate)) continue;

        const page = pagesById.get(pageId);
        const pageContent = content.get(pageId);
        if (page === undefined || pageContent === undefined || pageContent.textNodes.length === 0) {
          continue;
        }

        const count = rng.int(mix.suggestionsPerPage[0], mix.suggestionsPerPage[1]);

        for (let i = 0; i < count; i += 1) {
          const textNode = rng.pick(pageContent.textNodes);
          const from = randomIndex(rng, textNode);
          const to = rng.int(from, textNode.length);

          const kind = rng.pick(KINDS);
          const proposedContent = kind === 'delete' ? null : commentDocument(rng);

          const author = rng.pick(authors);
          const createdAt = minutesAfter(page.createdAt, rng.int(60, 20_000));
          const suggestionId = rng.uuid(createdAt);

          const decided = deciders.length > 0 && rng.chance(mix.suggestionDecidedShare);
          const accepted = decided && rng.chance(mix.suggestionAcceptedShare);
          const decider = decided ? rng.pick(deciders) : null;
          const decidedAt = decided ? minutesAfter(createdAt, rng.int(30, 8_000)) : null;
          const status = decided ? (accepted ? 'accepted' : 'rejected') : 'pending';

          rows.push([
            suggestionId,
            orgId,
            pageId,
            encodeAnchor(textNode, from),
            encodeAnchor(textNode, to),
            kind,
            proposedContent,
            status,
            decider?.user.id ?? null,
            decidedAt,
            author.user.id,
            createdAt,
          ]);

          ctx.emit(
            createEvent(
              pageSuggestionCreated,
              { suggestionId, pageId },
              envelopeFor(orgId, author.user.id, createdAt),
            ),
          );
          if (decided && decider !== null && decidedAt !== null) {
            ctx.emit(
              createEvent(
                pageSuggestionDecided,
                { suggestionId, pageId, status: accepted ? 'accepted' : 'rejected' },
                envelopeFor(orgId, decider.user.id, decidedAt),
              ),
            );
            decidedRows += 1;
          }
        }
      }

      if (rows.length === 0) continue;

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'docs.suggestions',
          [
            'id',
            'org_id',
            'page_id',
            'anchor_from',
            'anchor_to',
            'kind',
            'proposed_content::jsonb',
            'status',
            'decided_by',
            'decided_at',
            'author_id',
            'created_at',
          ],
          rows,
        );
      });

      suggestionRows += rows.length;
    }

    if (suggestionRows > 0) {
      ctx.log(
        `docs.suggestions: ${String(suggestionRows)} suggestions, ${String(decidedRows)} decided`,
      );
    }

    return { suggestionRows, decidedRows };
  },
});
