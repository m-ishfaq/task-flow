import * as Y from 'yjs';
import { createEvent } from '@taskflow/events';
import { pageTemplateCreated } from '@taskflow/api/events/docs';
import { pageBody, pageTemplateName } from '../corpus.js';
import type { Rng } from '../rng.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { membershipsWith, spacesModule, type SeededSpace } from './docs.spaces.js';
import { nodeFor } from './docs.content.js';

/**
 * Page templates (Phase 6, Wave 4) — "page_versions-shaped seed content" for
 * a space, per migration 0026's own header.
 *
 * ## A fresh standalone document, not a clone of a seeded page
 *
 * A template is reusable STARTING content ("Meeting notes", "Runbook"), not
 * a specific already-written page — reusing `docs.content`'s page bodies
 * here would produce a template that reads like someone's actual notes
 * rather than a shape to fill in. This module builds its own small `Y.Doc`
 * with `docs.content`'s own `nodeFor` (imported, not re-implemented — the
 * identical whitelist-by-construction argument that file's header makes),
 * so a seeded template is one `apps/collab`'s content guard leaves
 * untouched, same as every other Yjs fixture in this package.
 *
 * ## No WAL, no snapshot boundary — a template has exactly one state
 *
 * Unlike a page, a template is never live-edited through `apps/collab`; it
 * is written once (`saveTemplate`, `apps/api/src/docs/template.service.ts`)
 * and read back whole every time someone creates a page from it. So this
 * module needs none of `editDocument`'s transaction/snapshot machinery —
 * one `Y.Doc`, one `doc.transact()`, one `Y.encodeStateAsUpdate`.
 *
 * ## Author holds `space:manage`, never `space:read` alone
 *
 * `template.service.ts`'s own header: managing a space's reusable
 * vocabulary is `space:manage`'s tier, the identical split Work draws
 * between a project's label set (managed) and a card (edited) — mirrored
 * here by drawing authors from `membershipsWith(org, 'space:manage')`, the
 * same helper `docs.spaces` itself uses for the identical reason.
 */

export interface TemplateOutput {
  readonly templateRows: number;
}

/** A small, standalone document — see the file header on why this does not
 * reuse `editDocument`. */
function templateState(rng: Rng): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = rng.int(1, 2_147_483_647);

  const fragment = doc.getXmlFragment('content');
  const blocks = pageBody(rng, rng.int(2, 5));
  doc.transact(() => {
    fragment.push(blocks.map(nodeFor));
  });

  return Y.encodeStateAsUpdate(doc);
}

export const templatesModule = defineSeedModule({
  name: 'docs.templates',
  requires: [spacesModule],
  tables: ['docs.page_templates'],

  async seed(ctx): Promise<TemplateOutput> {
    const rng = ctx.rng.fork('docs.templates');
    const { spaces } = ctx.use(spacesModule);

    const byOrg = new Map<string, SeededSpace[]>();
    for (const space of spaces) {
      if ((space.plan.templates ?? 0) === 0) continue;
      const list = byOrg.get(space.orgId) ?? [];
      list.push(space);
      byOrg.set(space.orgId, list);
    }

    let templateRows = 0;

    for (const [orgId, orgSpaces] of byOrg) {
      const rows: unknown[][] = [];

      for (const space of orgSpaces) {
        const count = space.plan.templates ?? 0;
        const authors = membershipsWith(space.org, 'space:manage');
        if (authors.length === 0) {
          throw new Error(
            `docs.templates: org "${space.org.slug}" has nobody holding space:manage, so ` +
              `space "${space.name}"'s templates could not have been saved by anyone in it.`,
          );
        }

        for (let i = 0; i < count; i += 1) {
          const author = rng.pick(authors);
          const createdAt = minutesAfter(space.createdAt, rng.int(60, 40_000));
          const templateId = rng.uuid(createdAt);
          const name = pageTemplateName(rng);

          rows.push([
            templateId,
            orgId,
            space.id,
            name,
            Buffer.from(templateState(rng)),
            author.user.id,
            createdAt,
            createdAt,
          ]);

          ctx.emit(
            createEvent(
              pageTemplateCreated,
              { templateId, spaceId: space.id, name },
              envelopeFor(orgId, author.user.id, createdAt),
            ),
          );
        }
      }

      if (rows.length === 0) continue;

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'docs.page_templates',
          ['id', 'org_id', 'space_id', 'name', 'state', 'created_by', 'created_at', 'updated_at'],
          rows,
        );
      });

      templateRows += rows.length;
    }

    if (templateRows > 0) {
      ctx.log(`docs.templates: ${String(templateRows)} templates`);
    }

    return { templateRows };
  },
});
