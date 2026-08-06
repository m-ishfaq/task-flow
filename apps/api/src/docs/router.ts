import { z } from 'zod';
import { PageIdSchema, SpaceIdSchema } from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { DocsActor } from './shared.js';
import * as spaces from './space.service.js';
import * as pages from './page.service.js';
import * as pageVersions from './page-version.service.js';

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
            .object({ spaceId: SpaceIdSchema, parentPageId: PageIdSchema.nullable(), title: PageTitle })
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
    }),
  });
}
