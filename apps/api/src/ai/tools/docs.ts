import { z } from 'zod';
import { PageIdSchema, SpaceIdSchema } from '@taskflow/contracts';
import { createPage } from '../../docs/page.service.js';
import type { DocsActor } from '../../docs/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * `docs.create_page` (§4.1's table — "used by the org-onboarding bootstrap,
 * §6"). The last tool §4.1's own table named that no wave had built yet.
 *
 * **Title only, no body content — because that is genuinely all the real
 * service can do.** Docs Wave 1 shipped `docs.pages` as tree-only, no body
 * column at all (CLAUDE.md's own Phase 6 section); a page's actual content
 * is written exclusively through `apps/collab`'s Hocuspocus/Yjs sync, "the
 * one process allowed to write from a socket handler." There is no honest
 * "create this page with this text" service call for an ordinary HTTP
 * caller to make, AI tool included — a page the assistant creates is a
 * titled, empty node in the tree, exactly the shape §6's own bootstrap
 * describes ("a starter Docs space — a handful of pages... using the
 * `docs.create_page` tool"), never pre-filled prose. Anyone opening the new
 * page still writes its content the normal way.
 *
 * **Requires confirmation, even though §6 calls a created page "safe by
 * construction" and "trivially reversible" — a stronger case for
 * auto-execute than any other tool in this registry has had.** Kept
 * confirmation-gated anyway for the same reason every write tool here is:
 * one uniform rule (nothing writes without a human's explicit yes) is
 * simpler to reason about and audit than a per-tool risk judgment call,
 * and §4.2 itself never actually lists `docs.create_page` among the
 * examples it calls "cheap to undo" — that argument is this file's own
 * reading of §6, not the spec's.
 *
 * Same `can()` shape as every other tool: builds a `DocsActor` from the
 * calling member's own `Subject` and calls the real `createPage`, which
 * asks `page:create` on the parent page (or `space:create`... no, on the
 * SPACE itself when there is no parent) exactly as a human's "+ New page"
 * button does.
 */

const DocsCreatePageInput = z
  .object({
    spaceId: SpaceIdSchema,
    parentPageId: PageIdSchema.nullable().optional(),
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export function createDocsCreatePageTool(): ToolDefinition {
  return defineTool({
    name: 'docs.create_page',
    description:
      'Creates a new, empty Docs page with the given title, at the top level of a space or under a parent page. The page has no content yet — whoever opens it writes that themselves.',
    jsonSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string', description: 'The id of the Docs space to create the page in.' },
        parentPageId: {
          type: ['string', 'null'],
          description: 'The id of the parent page, or omit/null for a top-level page.',
        },
        title: { type: 'string', description: 'The page title.' },
      },
      required: ['spaceId', 'title'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: DocsCreatePageInput,
    async execute(ctx: ToolContext, input) {
      const actor: DocsActor = { subject: ctx.subject, requestId: ctx.requestId };
      const result = await createPage(actor, {
        spaceId: input.spaceId,
        parentPageId: input.parentPageId ?? null,
        title: input.title,
      });
      return { content: JSON.stringify({ pageId: result.pageId }) };
    },
  });
}
