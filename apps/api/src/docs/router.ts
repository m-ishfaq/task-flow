import { z } from 'zod';
import {
  CommentIdSchema,
  OrgIdSchema,
  PageIdSchema,
  PageTemplateIdSchema,
  SpaceIdSchema,
  SuggestionIdSchema,
} from '@taskflow/contracts';
import { route, router, publicRoute } from '../trpc/builder.js';
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
import { exportPagePdf } from './pdf-export.service.js';
import { getPublishedPage } from './public.service.js';
import { listBacklinks } from './backlinks.js';

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
/**
 * A single-line title.
 *
 * `.trim()` strips surrounding whitespace and permits everything in between,
 * including CR and LF. That matters beyond tidiness: a card or page title
 * reaches `notification-mail`'s `subject`, which is an SMTP header, and it is
 * rendered into a mail body and a PDF. Nodemailer sanitizes newlines out of
 * header values, so this was never exploitable — but that is an implicit
 * dependency on a library's internal behaviour, in a codebase that otherwise
 * refuses exactly that kind of reliance.
 *
 * `\p{Cc}` is the Unicode control category, so this rejects NUL and the C1
 * range too rather than only the two characters that happen to matter for
 * SMTP today.
 */
const PageTitle = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\p{Cc}]*$/u, 'A title cannot contain control characters or line breaks.');

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: DocsActor['requestId'];
}): DocsActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createDocsRouter() {
  return router({
    spaces: router({
      list: route({ permission: 'space:read', feature: { flag: 'docs', display: 'Docs' } })
        .output(
          z
            .array(
              z.object({ spaceId: z.string(), name: z.string(), archivedAt: z.date().nullable() }),
            )
            .readonly(),
        )
        .query(({ ctx }) => spaces.listSpaces(actorOf(ctx))),

      create: route({ permission: 'space:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ name: SpaceName }).strict())
        .output(z.object({ spaceId: z.string() }))
        .mutation(({ input, ctx }) => spaces.createSpace(actorOf(ctx), input)),

      archive: route({ permission: 'space:manage', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ spaceId: SpaceIdSchema, restore: z.boolean() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => spaces.archiveSpace(actorOf(ctx), input)),
    }),

    pages: router({
      list: route({ permission: 'page:read', feature: { flag: 'docs', display: 'Docs' } })
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
                publishedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => pages.listPages(actorOf(ctx), input)),

      create: route({ permission: 'page:create', feature: { flag: 'docs', display: 'Docs' } })
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

      update: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema, title: PageTitle }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pages.updatePage(actorOf(ctx), input)),

      move: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
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

      archive: route({ permission: 'page:delete', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema, restore: z.boolean() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pages.archivePage(actorOf(ctx), input)),

      /** `page:update` — see publish.service.ts's own header on why publish reuses this tier. */
      publish: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => publish.publishPage(actorOf(ctx), input)),

      unpublish: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => publish.unpublishPage(actorOf(ctx), input)),

      /**
       * `page:read` — exporting is a read, the same tier `attachment:download`
       * sits at. `versionId: null` means "the latest saved version" — see
       * `pdf-export.service.ts`'s own header. Bytes travel as base64 because
       * tRPC's wire format is JSON; there is no streaming response here the
       * way there is for attachments (§8.4's presigned-URL download), because
       * a rendered PDF has no independent object-storage identity to presign
       * — it is generated fresh, on demand, from a `page_versions` row.
       */
      /* PDF rendering is the expensive class's poster child — generated
         fresh from a page_versions row on demand (§6.5). */
      exportPdf: route({
        permission: 'page:read',
        quotaClass: 'expensive',
        feature: { flag: 'docs', display: 'Docs' },
      })
        .input(
          z
            .object({ pageId: PageIdSchema, versionId: z.string().nullable().default(null) })
            .strict(),
        )
        .output(z.object({ filename: z.string(), contentBase64: z.string() }))
        .mutation(async ({ input, ctx }) => {
          const { filename, bytes } = await exportPagePdf(actorOf(ctx), input);
          return { filename, contentBase64: Buffer.from(bytes).toString('base64') };
        }),
    }),

    pageVersions: router({
      list: route({ permission: 'page:read', feature: { flag: 'docs', display: 'Docs' } })
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

      save: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(z.object({ versionId: z.string() }))
        .mutation(({ input, ctx }) => pageVersions.savePageVersion(actorOf(ctx), input)),

      restore: route({ permission: 'page:update', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema, versionId: z.string() }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => pageVersions.restorePageVersion(actorOf(ctx), input)),
    }),

    comments: router({
      list: route({ permission: 'page:read', feature: { flag: 'docs', display: 'Docs' } })
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
      create: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
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
      update: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ commentId: CommentIdSchema, body: RichTextDocument }).strict())
        .output(z.object({ edited: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.updateComment(actorOf(ctx), input)),

      /** Anyone who can comment can resolve — see comment.service.ts's own header. */
      resolve: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ commentId: CommentIdSchema, resolved: z.boolean() }).strict())
        .output(z.object({ resolved: z.boolean() }))
        .mutation(({ input, ctx }) => comments.resolveComment(actorOf(ctx), input)),

      /** Declared `comment:create` — the floor. The service escalates to `comment:delete` when the caller is not the author. */
      delete: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ commentId: CommentIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => comments.deleteComment(actorOf(ctx), input)),
    }),

    suggestions: router({
      list: route({ permission: 'page:read', feature: { flag: 'docs', display: 'Docs' } })
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
      create: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
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
      decide: route({ permission: 'comment:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(
          z
            .object({ suggestionId: SuggestionIdSchema, status: z.enum(['accepted', 'rejected']) })
            .strict(),
        )
        .output(z.object({ status: z.enum(['accepted', 'rejected']) }))
        .mutation(({ input, ctx }) => suggestions.decideSuggestion(actorOf(ctx), input)),
    }),

    /**
     * Page templates (§5, Wave 4) — see template.service.ts's own header on
     * why `space:read`/`space:manage` cover this with no new permission.
     */
    templates: router({
      list: route({ permission: 'space:read', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ spaceId: SpaceIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                templateId: z.string(),
                spaceId: z.string(),
                name: z.string(),
                createdBy: z.string().nullable(),
                createdAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => templates.listTemplates(actorOf(ctx), input)),

      create: route({ permission: 'space:manage', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema, name: z.string().trim().min(1).max(200) }).strict())
        .output(z.object({ templateId: z.string() }))
        .mutation(({ input, ctx }) => templates.createTemplateFromPage(actorOf(ctx), input)),

      delete: route({ permission: 'space:manage', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ templateId: PageTemplateIdSchema }).strict())
        .output(z.void())
        .mutation(({ input, ctx }) => templates.deleteTemplate(actorOf(ctx), input)),

      /** `page:create` — using a template is exactly `pages.create`, see template.service.ts's header. */
      createPage: route({ permission: 'page:create', feature: { flag: 'docs', display: 'Docs' } })
        .input(
          z
            .object({
              spaceId: SpaceIdSchema,
              parentPageId: PageIdSchema.nullable(),
              title: PageTitle,
              templateId: PageTemplateIdSchema,
            })
            .strict(),
        )
        .output(z.object({ pageId: z.string() }))
        .mutation(({ input, ctx }) => templates.createPageFromTemplate(actorOf(ctx), input)),
    }),

    /**
     * "What links here" (§3.10, Wave 3) — the read side of the backlinks
     * relay, which until now only ever WROTE `docs.backlinks`
     * (`backlinks.relay.ts`). See `backlinks.ts`'s own header on why there
     * is no per-row `enforceOnPage`.
     */
    backlinks: router({
      list: route({ permission: 'page:read', feature: { flag: 'docs', display: 'Docs' } })
        .input(z.object({ pageId: PageIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                sourcePageId: z.string(),
                sourceTitle: z.string(),
                sourceSpaceId: z.string(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => listBacklinks(actorOf(ctx), input)),
    }),

    /**
     * The anonymous, no-session read path for a published page (§3.9,
     * Wave 4). See public.service.ts's own header on why `orgId` is a plain
     * input here rather than coming from a token — there is no token.
     */
    public: router({
      getPage: publicRoute({
        publicReason: 'This is how a published page is viewed by someone with no account at all.',
      })
        .input(z.object({ orgId: OrgIdSchema, pageId: PageIdSchema }).strict())
        .output(
          z.object({
            pageId: z.string(),
            title: z.string(),
            publishedAt: z.string(),
            content: z.unknown(),
          }),
        )
        .query(({ input }) => getPublishedPage(input)),
    }),
  });
}
