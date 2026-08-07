import * as Y from 'yjs';
import { createEvent } from '@taskflow/events';
import { pageCommentCreated, pageCommentResolved } from '@taskflow/api/events/docs';
import { commentDocument, flatten } from '../corpus.js';
import type { Rng } from '../rng.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { contentModule } from './docs.content.js';
import { membershipsWith, spacesModule, type SeededPage } from './docs.spaces.js';

/**
 * Page comments (Phase 6, Wave 3).
 *
 * ## Anchors are real `RelativePosition`s, not placeholder bytes
 *
 * `docs.comments.anchor_from`/`anchor_to` are `bytea` holding a Yjs
 * `RelativePosition`, structurally validated on the real API path by
 * `Y.decodeRelativePosition` (`apps/api/src/docs/anchor.ts`) and never
 * meaningfully interpreted server-side otherwise. `docs.content`'s own header
 * makes the identical argument for WAL bytes: bytes a real decoder will run
 * against have to come from the real encoder, or the fixture is a comment that
 * throws the moment anyone opens the page it claims to be anchored to. Every
 * anchor here is `Y.createRelativePositionFromTypeIndex` against a `Y.XmlText`
 * `docs.content` actually built for that page (`ContentOutput.pages`), at a
 * real index into its real length — never a fabricated offset.
 *
 * ## Only pages `docs.content` gave a body can have a comment
 *
 * There is nothing to anchor a comment to on a page with no content, and
 * `docs.content`'s `pages` map only contains pages that got one — the
 * membership check below (`pages.get(page.id)`) is what enforces this rather
 * than a second content check duplicated here.
 *
 * ## Resolving is `comment:create`'s tier, same as authoring
 *
 * `comment.service.ts`'s own header: resolving is not moderation, any account
 * that could comment can resolve — mirrored here by drawing the resolver from
 * the identical `comment:create` pool the author came from, not a narrower one.
 */

export interface CommentOutput {
  readonly commentRows: number;
  readonly resolvedRows: number;
}

/** A random index within `text`'s length, inclusive of both ends. */
function randomIndex(rng: Rng, text: Y.XmlText): number {
  return rng.int(0, text.length);
}

function encodeAnchor(type: Y.XmlText, index: number): Buffer {
  return Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index)));
}

export const commentsModule = defineSeedModule({
  name: 'docs.comments',
  requires: [spacesModule, contentModule],
  tables: ['docs.comments'],

  async seed(ctx): Promise<CommentOutput> {
    const rng = ctx.rng.fork('docs.comments');
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

    let commentRows = 0;
    let resolvedRows = 0;

    for (const [orgId, pageIds] of byOrg) {
      const rows: unknown[][] = [];
      const org = pagesById.get(pageIds[0] ?? '')?.space.org;
      if (org === undefined) continue;

      const authors = membershipsWith(org, 'comment:create');
      if (authors.length === 0) continue;

      for (const pageId of pageIds) {
        if (!rng.chance(mix.commentRate)) continue;

        const page = pagesById.get(pageId);
        const pageContent = content.get(pageId);
        if (page === undefined || pageContent === undefined || pageContent.textNodes.length === 0) {
          continue;
        }

        const count = rng.int(mix.commentsPerPage[0], mix.commentsPerPage[1]);

        for (let i = 0; i < count; i += 1) {
          const textNode = rng.pick(pageContent.textNodes);
          const from = randomIndex(rng, textNode);
          const to = rng.int(from, textNode.length);

          const author = rng.pick(authors);
          const createdAt = minutesAfter(page.createdAt, rng.int(60, 20_000));
          const commentId = rng.uuid(createdAt);
          const document = commentDocument(rng);
          const bodyText = flatten(document);

          const resolved = rng.chance(mix.resolvedShare);
          const resolver = resolved ? rng.pick(authors) : null;
          const resolvedAt = resolved ? minutesAfter(createdAt, rng.int(30, 5_000)) : null;

          rows.push([
            commentId,
            orgId,
            pageId,
            encodeAnchor(textNode, from),
            encodeAnchor(textNode, to),
            document,
            bodyText,
            resolvedAt,
            resolver?.user.id ?? null,
            author.user.id,
            null,
            null,
            createdAt,
          ]);

          ctx.emit(
            createEvent(
              pageCommentCreated,
              { commentId, pageId },
              envelopeFor(orgId, author.user.id, createdAt),
            ),
          );
          if (resolved && resolver !== null && resolvedAt !== null) {
            ctx.emit(
              createEvent(
                pageCommentResolved,
                { commentId, pageId, resolved: true },
                envelopeFor(orgId, resolver.user.id, resolvedAt),
              ),
            );
            resolvedRows += 1;
          }
        }
      }

      if (rows.length === 0) continue;

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'docs.comments',
          [
            'id',
            'org_id',
            'page_id',
            'anchor_from',
            'anchor_to',
            'body::jsonb',
            'body_text',
            'resolved_at',
            'resolved_by',
            'author_id',
            'edited_at',
            'deleted_at',
            'created_at',
          ],
          rows,
        );
      });

      commentRows += rows.length;
    }

    if (commentRows > 0) {
      ctx.log(`docs.comments: ${String(commentRows)} comments, ${String(resolvedRows)} resolved`);
    }

    return { commentRows, resolvedRows };
  },
});
