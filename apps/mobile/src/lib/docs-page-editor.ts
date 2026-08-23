import type { PendingMention } from './message-compose.js';

/**
 * The pure logic behind `docs-page/[pageId].tsx`'s "Edit" mode — deciding
 * whether it is safe to enter, and what to seed the composer with. The
 * actual read/write of Yjs content lives in `docs-collab.ts`
 * (`yjsFragmentToRichTextDocument`/`writeRichTextDocumentToFragment`); the
 * markdown-ish text itself is `rich-text-compose.ts`'s
 * `parseFormattedText`/`serializeToText`. This file is what sits between
 * them and a page's real, possibly-already-authored-on-web content.
 *
 * ## Whole-page save, not live collaborative typing — and why that is honest
 *
 * `writeRichTextDocumentToFragment` replaces a page's ENTIRE content in
 * one Yjs transaction. That is not the same claim as "the same editing
 * experience as web": there is no per-keystroke sync while composing, no
 * cursor presence, and no operational merge with someone else's
 * concurrent edit — only `docs-page/[pageId].tsx`'s own save-time check
 * against a captured baseline (see that file for the actual conflict
 * warning). It is real writing, synced to every connected client
 * (including web) the moment Save lands, which is the honest, buildable
 * middle this codebase settled on once true live editing was ruled out —
 * ProseMirror needs a DOM, and this platform has none.
 *
 * ## `pageLink` is the one node type that cannot round-trip
 *
 * `rich-text-compose.ts`'s `serializeToText` already documents this: a
 * `pageLink` node serializes to its plain `label` text, and re-parsing
 * never turns that back into a real reference — the label survives, the
 * LINK does not. `hasPageLink` is the pre-flight check `docs-page/
 * [pageId].tsx` runs before entering edit mode, so a page's internal
 * links are named as a real, visible trade before someone loses one
 * silently, not discovered after the fact in a diff nobody reviewed.
 * `hardBreak` (a soft line break inside one paragraph) has a softer,
 * accepted degradation — it becomes a separate paragraph on save, a
 * visual nuance rather than a lost reference — and is deliberately NOT
 * gated on for that reason.
 */

interface WalkableNode {
  readonly type?: unknown;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly WalkableNode[];
}

function nodesOf(document: unknown): readonly WalkableNode[] {
  if (typeof document !== 'object' || document === null) return [];
  const content = (document as { readonly content?: unknown }).content;
  return Array.isArray(content) ? (content as readonly WalkableNode[]) : [];
}

function walk(nodes: readonly WalkableNode[], visit: (node: WalkableNode) => boolean): boolean {
  for (const node of nodes) {
    if (visit(node)) return true;
    if (node.content !== undefined && walk(node.content, visit)) return true;
  }
  return false;
}

/** True if editing and saving this page would silently drop a link to
 *  another page — the one node type `rich-text-compose.ts` cannot
 *  round-trip through plain text. */
export function hasPageLink(document: unknown): boolean {
  return walk(nodesOf(document), (node) => node.type === 'pageLink');
}

/**
 * Every `mention` already in a page's content, as the `PendingMention`
 * list `parseFormattedText` needs to turn a RETYPED `@Label` marker back
 * into a real mention node — `rich-text-compose.ts`'s own header on
 * `serializeToText` explains why this seeding is what makes an EXISTING
 * mention round-trip (the exact label text must still appear verbatim
 * after editing); it does not let the editor CREATE a new one, since
 * there is no mention picker on this screen. Deduplicated by `userId` —
 * the same person mentioned twice in one page needs only one entry for
 * either occurrence to resolve.
 */
export function extractMentions(document: unknown): readonly PendingMention[] {
  const found = new Map<string, PendingMention>();
  walk(nodesOf(document), (node) => {
    if (node.type !== 'mention') return false;
    const userId = node.attrs?.['userId'];
    const label = node.attrs?.['label'];
    if (typeof userId === 'string' && typeof label === 'string' && !found.has(userId)) {
      found.set(userId, { userId, label });
    }
    return false;
  });
  return [...found.values()];
}
