import * as Y from 'yjs';
import { MarkSchema, NODE_ATTRIBUTES, NODE_TYPES, type NodeType } from '../work/richtext.js';

/**
 * Materialized Yjs content -> plain JSON (Wave 4, §3.9). The one converter
 * `docs/public.ts` (the anonymous read path) and `docs/pdf.ts` (export)
 * both go through, rather than each walking `Y.XmlFragment` independently.
 *
 * ## Why this re-validates against the whitelist AGAIN
 *
 * `apps/collab/src/content-guard.ts` already strips disallowed content at
 * the save-boundary (§3.8) — but only at that boundary. Its own header names
 * the gap directly: "a disallowed node can exist in live, uncommitted CRDT
 * state for as long as it takes to reach the next validation pass." Every
 * OTHER reader of page content is an authenticated org member, whose own
 * session is already the accepted risk boundary the rest of this system
 * runs on. This module is different: `public.ts` serves whoever has the
 * page's URL, with no session at all, and `pdf.ts` produces a file meant to
 * be forwarded outside the org entirely. Trusting "already-guarded" content
 * blindly here would mean the one surface with NO other authorization layer
 * behind it is the one place a stale, not-yet-compacted `javascript:` link or
 * an unknown node type could reach an audience that never authenticated at
 * all. So this file does not mutate or trust the source `Y.Doc` (which, for
 * both callers, is always a throwaway just-materialized copy from
 * `materializeCurrentState`/a stored snapshot, never the live collaborative
 * document — mutating it would be pointless even if this did rewrite it in
 * place) — it independently re-derives a clean tree, dropping exactly what
 * `enforceContentWhitelist` would have stripped, as a pure read rather than
 * a second in-place edit.
 *
 * ## Why nodes with invalid attributes are DROPPED here, not attr-stripped
 *
 * `content-guard.ts` clears just the bad attributes and keeps the node,
 * which is the right call for a LIVE document a user is still editing — an
 * empty-attrs `heading` is still a reasonable paragraph-like thing to leave
 * in someone's draft. A published, read-only render has no such continuity
 * to preserve and no editor around to notice and fix it: `pageLink` and
 * `mention` both have REQUIRED attributes (`pageId`/`userId` + `label`), and
 * a stripped-to-`{}` version of either fails its own schema and renders
 * nothing meaningful. Dropping the node outright is simpler and never
 * produces a half-broken reference in a document nobody can now edit.
 */

export interface RenderedNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly text?: string;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  readonly content?: readonly RenderedNode[];
}

const MARK_HASH_SUFFIX = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

function baseMarkName(attributeKey: string): string {
  return MARK_HASH_SUFFIX.exec(attributeKey)?.[1] ?? attributeKey;
}

function isKnownNodeType(nodeName: string): nodeName is NodeType {
  return (NODE_TYPES as readonly string[]).includes(nodeName);
}

interface DeltaSegment {
  readonly insert: string;
  readonly attributes?: Record<string, unknown>;
}

/** Marks on one delta segment that pass `MarkSchema`, in the wire's `{type, attrs?}` shape. */
function marksOf(
  segment: DeltaSegment,
): readonly { type: string; attrs?: Record<string, unknown> }[] {
  if (!segment.attributes) return [];

  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  for (const [key, value] of Object.entries(segment.attributes)) {
    const markType = baseMarkName(key);
    const hasAttrs = value !== null && typeof value === 'object' && Object.keys(value).length > 0;
    const candidate = hasAttrs ? { type: markType, attrs: value } : { type: markType };

    const parsed = MarkSchema.safeParse(candidate);
    if (!parsed.success) continue;
    marks.push(parsed.data);
  }
  return marks;
}

function renderText(text: Y.XmlText): readonly RenderedNode[] {
  const delta = text.toDelta() as readonly DeltaSegment[];
  const nodes: RenderedNode[] = [];

  for (const segment of delta) {
    if (segment.insert.length === 0) continue;
    const marks = marksOf(segment);
    nodes.push(
      marks.length > 0
        ? { type: 'text', text: segment.insert, marks }
        : { type: 'text', text: segment.insert },
    );
  }
  return nodes;
}

function renderElement(element: Y.XmlElement): RenderedNode | null {
  if (!isKnownNodeType(element.nodeName)) return null;

  const attrs = element.getAttributes();
  const schema = NODE_ATTRIBUTES[element.nodeName];
  if (!schema.safeParse(attrs).success) return null;

  const content = renderChildren(element);
  const node: RenderedNode = {
    type: element.nodeName,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
  return node;
}

function renderChildren(parent: Y.XmlFragment | Y.XmlElement): readonly RenderedNode[] {
  const nodes: RenderedNode[] = [];
  for (let index = 0; index < parent.length; index++) {
    const child = parent.get(index);
    if (child instanceof Y.XmlElement) {
      const rendered = renderElement(child);
      if (rendered) nodes.push(rendered);
    } else if (child instanceof Y.XmlText) {
      nodes.push(...renderText(child));
    }
  }
  return nodes;
}

/** The materialized document as a plain, already-whitelisted JSON tree — `{ type: 'doc', content: [...] }`. */
export function renderFragment(fragment: Y.XmlFragment): RenderedNode {
  return { type: 'doc', content: renderChildren(fragment) };
}

/**
 * A materialized Yjs state (as `page_versions.state`/`materializeCurrentState`
 * produce it) decoded into a fresh, throwaway `Y.Doc` and rendered. The doc
 * is discarded immediately after — nothing here is ever the live document.
 */
export function renderState(state: Uint8Array): RenderedNode {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return renderFragment(doc.getXmlFragment('content'));
}
