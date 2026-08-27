import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Docs page templates (Phase 6 Wave 4, ported). Types and the one query key.
 *
 * `templates.createPage` is pure create-and-navigate, entirely server-side
 * — `apps/api/src/docs/template.service.ts`'s `createPageFromTemplate`
 * copies a stored Yjs snapshot (`docs.page_templates.state`) into the new
 * page's first version row; no client ever reads or sends template
 * content. That is what makes templates fully portable with no editor: a
 * mobile caller only ever sends a `templateId` string, exactly like web's
 * own `<select>` picker does.
 */
export type DocTemplate = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['templates']['list']['query']>>
>[number];

export function templatesQueryKey(spaceId: string): readonly ['docs.templates.list', string] {
  return ['docs.templates.list', spaceId];
}
