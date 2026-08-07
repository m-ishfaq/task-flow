import { z } from 'zod';
import {
  CommentIdSchema,
  PageIdSchema,
  SpaceIdSchema,
  SuggestionIdSchema,
  TemplateIdSchema,
} from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { RichTextDocument } from '../work/richtext.js';
import type { DocsActor } from './shared.js';
import { AnchorSchema } from './anchor.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as pageVersions from './page-version.service.js';
import * as comments from './comment.service.js';
import * as suggestions from './suggestion.service.js';
import * as publish from './publish.service.js';
import * as templates from './template.service.js';

/**
 * Docs routes — spaces, the page tree, and page versions (ai/phase-6-docs.md
 * §5, Wave 1 + Wave 2).
 *
 * No live content collaboration here — that is `apps/collab`, a separate
 * process by design (§3.2). Everything below is tree position, metadata, and
 * (Wave 2) version save/restore, all on the ordinary API path, exactly like
 * Work and Chat.
 *
 * `route({ permission })` is layer 1, same caveat chat/router.ts states for
 * itself: for a page it barely narrows anything, because `MEMBER` holds
 * `page:read`/`page:create`/`page:update` from the role matrix regardless of
 * which page is named. Layer 2 — `enforceOnPage`/`enforceOnSpace`, once the
 * row (and its ancestor chain) is loaded — is where a page is actually
 * decided.
 */

const SpaceName = z.string().trim().min(1).max(200);
const PageTitle = z.string().trim().min(1).max(500);

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: DocsActor['requestId'];
}): DocsActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createDocsRouter() {
  return router({
    spaces: router({
      list: route({ permission: 'space:read' })
        .output(
          z
            .array(
              z.object({ spaceId: z.string(), name: z.string(), archivedAt: z.date().nullable() }),
            )
            .readonly(),
        )
        .query(({ ctx }) => spaces.listSpaces(actorOf(ctx))),

      create: route({ permission: 'space:create' })
        .input(z.object({ name: SpaceName }).strict())
        .output(z.object({ spaceId: z.string() }))
        .mutation(({ input, ctx }) => spaces.createSpace(actorOf(ctx), input)),

      archive: route({ permission: 'space:manage' })
        .input(z.object({ spaceId: SpaceIdSchema, restore: z.boolean() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => spaces.archiveSpace(actorOf(ctx), input)),
    }),

    pages: router({
      list: route({ permission: 'page:read' })
        .input(z.object({ spaceId: SpaceIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                pageId: z.string(),
                parentPageId: z.string().nullable(),
                title: z.string(),
                rank: z.string(),
                archivedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => pages.listPages(actorOf(ctx), input)),

      create: route({ permission: 'page:create' })
        .input(
          z
            .object({
              spaceId: SpaceIdSchema,
              parentPageId: PageIdSchema.nullable(),
              title: PageTitle,
            })
            .strict(),
        )
        .output(z.object({ pageId: z.string() }))
        .mutation(({ input, ctx }) => pages.createPage(actorOf(ctx), input)),

      update: route({ permission: 'page:update' })
        .input(z.object({ pageId: PageIdSchema, title: PageTitle }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pages.updatePage(actorOf(ctx), input)),

      move: route({ permission: 'page:update' })
        .input(
          z
            .object({
              pageId: PageIdSchema,
              targetParentId: PageIdSchema.nullable(),
              beforePageId: PageIdSchema.nullable(),
              afterPageId: PageIdSchema.nullable(),
            })
            .strict(),
        )
        .output(z.object({ rank: z.string(), rebalanced: z.boolean() }))
        .mutation(({ input, ctx }) => pages.movePage(actorOf(ctx), input)),

      archive: route({ permission: 'page:delete' })
        .input(z.object({ pageId: PageIdSchema, restore: z.boolean() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pages.archivePage(actorOf(ctx), input)),

      /** §3.9 — admin/owner only (packages/policy/src/roles.ts). */
      publish: route({ permission: 'page:publish' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.object({ versionId: z.string() }))
        .mutation(({ input, ctx }) => publish.publishPage(actorOf(ctx), input)),

      unpublish: route({ permission: 'page:publish' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => publish.unpublishPage(actorOf(ctx), input)),

      createFromTemplate: route({ permission: 'page:create' })
        .input(
          z
            .object({
              spaceId: SpaceIdSchema,
              parentPageId: PageIdSchema.nullable(),
              title: PageTitle,
              templateId: TemplateIdSchema,
            })
            .strict(),
        )
        .output(z.object({ pageId: z.string() }))
        .mutation(({ input, ctx }) => templates.createPageFromTemplate(actorOf(ctx), input)),
    }),

    pageVersions: router({
      list: route({ permission: 'page:read' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                versionId: z.string(),
                kind: z.string(),
                createdBy: z.string().nullable(),
                createdAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => pageVersions.listPageVersions(actorOf(ctx), input)),

      save: route({ permission: 'page:update' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.object({ versionId: z.string() }))
        .mutation(({ input, ctx }) => pageVersions.savePageVersion(actorOf(ctx), input)),

      restore: route({ permission: 'page:update' })
        .input(z.object({ pageId: PageIdSchema, versionId: z.string() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pageVersions.restorePageVersion(actorOf(ctx), input)),

      /**
       * Base64 in an ordinary tRPC response, not a second authenticated
       * binary route — §3.9's own reasoning is in
       * `page-version.service.ts#exportPageVersionPdf`'s header. `null`
       * exports the current materialized state rather than a saved version.
       */
      exportPdf: route({ permission: 'page:read' })
        .input(z.object({ pageId: PageIdSchema, versionId: z.string().nullable() }).strict())
        .output(z.object({ filename: z.string(), base64: z.string() }))
        .query(({ input, ctx }) => pageVersions.exportPageVersionPdf(actorOf(ctx), input)),
    }),

    templates: router({
      list: route({ permission: 'page:read' })
        .output(
          z
            .array(
              z.object({
                templateId: z.string(),
                name: z.string(),
                description: z.string().nullable(),
                sourcePageId: z.string().nullable(),
                createdBy: z.string().nullable(),
                createdAt: z.date(),
                archivedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => templates.listTemplates(actorOf(ctx))),

      create: route({ permission: 'page:create' })
        .input(
          z
            .object({
              name: z.string().trim().min(1).max(200),
              description: z.string().trim().max(2000).nullable(),
              sourcePageId: PageIdSchema,
            })
            .strict(),
        )
        .output(z.object({ templateId: z.string() }))
        .mutation(({ input, ctx }) => templates.createTemplate(actorOf(ctx), input)),

      /** Admin/owner only — see template.service.ts's own header on the moderation-tier split. */
      archive: route({ permission: 'page:delete' })
        .input(z.object({ templateId: TemplateIdSchema, restore: z.boolean() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => templates.archiveTemplate(actorOf(ctx), input)),
    }),

    comments: router({
      list: route({ permission: 'page:read' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                commentId: z.string(),
                pageId: z.string(),
                anchorFrom: z.string(),
                anchorTo: z.string(),
                authorId: z.string().nullable(),
                body: z.unknown(),
                bodyText: z.string(),
                resolvedAt: z.date().nullable(),
                resolvedBy: z.string().nullable(),
                editedAt: z.date().nullable(),
                deletedAt: z.date().nullable(),
                createdAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => comments.listComments(actorOf(ctx), input)),

      /** `comment:create` — same floor Work's card comments use, for the identical reason (§3.6). */
      create: route({ permission: 'comment:create' })
        .input(
          z
            .object({
              pageId: PageIdSchema,
              anchorFrom: AnchorSchema,
              anchorTo: AnchorSchema,
              body: RichTextDocument,
            })
            .strict(),
        )
        .output(z.object({ commentId: z.string() }))
        .mutation(({ input, ctx }) => comments.createComment(actorOf(ctx), input)),

      /** Author only, enforced in the service — no permission overrides it. */
      update: route({ permission: 'comment:create' })
        .input(z.object({ commentId: CommentIdSchema, body: RichTextDocument }).strict())
        .output(z.object({ edited: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.updateComment(actorOf(ctx), input)),

      /** Anyone who can comment can resolve — see comment.service.ts's own header. */
      resolve: route({ permission: 'comment:create' })
        .input(z.object({ commentId: CommentIdSchema, resolved: z.boolean() }).strict())
        .output(z.object({ resolved: z.boolean() }))
        .mutation(({ input, ctx }) => comments.resolveComment(actorOf(ctx), input)),

      /** Declared `comment:create` — the floor. The service escalates to `comment:delete` when the caller is not the author. */
      delete: route({ permission: 'comment:create' })
        .input(z.object({ commentId: CommentIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.deleteComment(actorOf(ctx), input)),
    }),

    suggestions: router({
      list: route({ permission: 'page:read' })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                suggestionId: z.string(),
                pageId: z.string(),
                anchorFrom: z.string(),
                anchorTo: z.string(),
                kind: z.string(),
                proposedContent: z.unknown(),
                status: z.string(),
                authorId: z.string().nullable(),
                decidedBy: z.string().nullable(),
                decidedAt: z.date().nullable(),
                createdAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => suggestions.listSuggestions(actorOf(ctx), input)),

      /** `comment:create` — proposing a change needs no edit right. See suggestion.service.ts's header. */
      create: route({ permission: 'comment:create' })
        .input(
          z
            .object({
              pageId: PageIdSchema,
              anchorFrom: AnchorSchema,
              anchorTo: AnchorSchema,
              kind: z.enum(['insert', 'delete', 'replace']),
              proposedContent: RichTextDocument.nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ suggestionId: z.string() }))
        .mutation(({ input, ctx }) => suggestions.createSuggestion(actorOf(ctx), input)),

      /**
       * Declared `comment:create` — the floor. The service escalates to
       * `page:update` unless this is the author withdrawing (rejecting) their
       * own still-pending suggestion, which needs no editing right either.
       */
      decide: route({ permission: 'comment:create' })
        .input(
          z
            .object({ suggestionId: SuggestionIdSchema, status: z.enum(['accepted', 'rejected']) })
            .strict(),
        )
        .output(z.object({ status: z.enum(['accepted', 'rejected']) }))
        .mutation(({ input, ctx }) => suggestions.decideSuggestion(actorOf(ctx), input)),
    }),
  });
}
