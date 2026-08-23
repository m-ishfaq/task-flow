import * as Y from 'yjs';
import { encodeBase64 } from './base64.js';

/**
 * The live collaborative connection for one Docs page (Phase 6, ported to
 * native) — the pure, testable half. `use-doc-page.ts` (a `.tsx`-adjacent
 * file, since it needs React and the native `WebSocket` global) is where
 * the actual `HocuspocusProvider` gets constructed; this file is the two
 * things that can be reasoned about with no live socket at all: naming the
 * document, and turning its SYNCED Yjs content back into something this
 * app already knows how to render.
 *
 * ## `pageDocumentName`, mirrored exactly
 *
 * Copied verbatim from `apps/web/src/features/docs/editor/collab-url.ts`,
 * which is itself a restatement of `apps/collab/src/document-name.ts`'s
 * own contract on the client side (that file is a server package neither
 * client has a dependency path to). Both ends must agree on the wire
 * format; this is the third copy of that one string template, not a
 * second one inventing a new convention.
 *
 * ## `yjsFragmentToRichTextDocument` — the one genuinely new piece
 *
 * There is no `pages.getContent` route (see `docs.ts`'s own header for
 * why) — the only place a page's real content exists is the live Yjs
 * document this app now connects to. But once synced, that document's
 * `content` field (a `Y.XmlFragment`, the same field name
 * `apps/web/src/features/docs/editor/docs-editor.tsx`'s own `Collaboration
 * .configure({ field: 'content' })` binds to) is structurally the SAME
 * tree shape TipTap's own JSON export would produce — `Y.XmlElement.
 * nodeName` is the ProseMirror node type name directly (`paragraph`,
 * `heading`, …), `getAttributes()` is the node's `attrs`, and `Y.XmlText.
 * toDelta()` is Quill-delta runs whose `attributes` keys are mark type
 * names (`bold`, `link`, …) — the exact vocabulary `apps/collab/src/
 * content-guard.ts`'s `enforceContentWhitelist` already enforces against
 * `@taskflow/api/richtext`'s shared schema, the SAME schema Work's rich
 * text uses. That is what makes this function's whole job possible: walk
 * the Yjs tree into that plain-JSON shape, and `rich-text-view.tsx`'s
 * EXISTING `RichTextView` — built for Work, never touched here — renders
 * it with zero new rendering code. `mention` and `pageLink` were already
 * handled there before this file existed.
 *
 * This walk is deliberately permissive rather than exhaustively validated
 * against the schema: `RichTextView` itself runs everything through
 * `sanitizeRichText` before rendering a byte of it, so a node this
 * function got subtly wrong (an attribute in the wrong shape, an
 * unexpected nesting) is dropped there rather than rendered wrong or
 * thrown on — the same safety net that lets a rule with an action this
 * build has never heard of still list without crashing elsewhere in this
 * app. `Y.XmlHook` (a rarely-used Yjs embed type TipTap/y-prosemirror
 * never emits) is skipped for the identical reason.
 *
 * **Unverified**: this is reasoned from Yjs's and y-prosemirror's
 * documented behavior, not confirmed against a real synced document — this
 * environment has no Docker to run `apps/collab` against and no device to
 * open a real page from. The tests below build representative Yjs
 * structures BY HAND, using Yjs's own real API (not a mock), which is
 * where genuine confidence comes from here: `yjs` itself is pure JS with
 * no DOM or native dependency, so it runs identically in Vitest and on a
 * device. What those tests cannot prove is that TipTap's live Yjs binding
 * shapes content EXACTLY as assumed here — that needs a real save from a
 * real editor, which is real, separate confirmation work.
 *
 * ## `pageStartAnchor` — the other genuinely new piece
 *
 * Comment/suggestion anchors on web are TEXT-RANGE positions, built by
 * converting a ProseMirror selection through `@tiptap/y-tiptap`'s
 * editor-state binding — see `apps/api/src/docs/anchor.ts`'s own header for
 * why the server never builds one itself. This app has no editor and
 * therefore no selection to convert; `pageStartAnchor` builds the same wire
 * shape (a base64-encoded `Y.RelativePosition`) at a fixed point instead —
 * index 0 of the content fragment itself — so a mobile comment/suggestion
 * is anchored to the PAGE rather than to a phrase in it. The server-side
 * `decodeAnchor` genuinely cannot tell the difference: it validates that
 * the bytes decode, never what position they name.
 */

export function pageDocumentName(pageId: string): string {
  return `page:${pageId}`;
}

/**
 * The `/collab` WebSocket URL for a page. Unlike web's own
 * `collabWebsocketUrl` (same-origin, reading `window.location`), a phone
 * has no origin to be "the same" as — this builds the URL from the
 * configured collab base origin instead, mirroring how `app-session.ts`'s
 * three Socket.IO connections already resolve `config.realtimeBaseUrl`
 * rather than assuming same-origin.
 */
export function collabWebsocketUrl(collabBaseUrl: string, orgId: string): string {
  const scheme = collabBaseUrl.startsWith('https:') ? 'wss:' : 'ws:';
  const host = collabBaseUrl.replace(/^https?:/, '');
  return `${scheme}${host}/collab?orgId=${encodeURIComponent(orgId)}`;
}

/**
 * A comment/suggestion anchor at the very start of a page's content — "this
 * comment belongs to the page," not to a text range. `apps/web`'s own
 * anchor builder (`editor/anchor.ts`) needs a live ProseMirror↔Yjs binding
 * (`@tiptap/y-tiptap`'s `absolutePositionToRelativePosition`, reading the
 * selection's `[from, to]` off `editor.state`) to turn a selected range into
 * one — this app has no editor and therefore no selection to convert. The
 * WIRE FORMAT is identical either way: `apps/api/src/docs/anchor.ts`'s
 * `decodeAnchor` only checks that the bytes are A well-formed
 * `Y.RelativePosition` (`Y.decodeRelativePosition` either parses or
 * throws) — it was never told, and never asks, what position a relative
 * position names. So a page-level anchor, built with pure Yjs and no
 * ProseMirror at all, is exactly as valid a `docs.comments.create`/
 * `docs.suggestions.create` payload as a true text-range one.
 *
 * `Y.createRelativePositionFromTypeIndex(fragment, 0)` anchors at index 0
 * of the CONTENT FRAGMENT ITSELF — not inside any one paragraph's
 * `Y.XmlText` — so it names a stable point that exists for the lifetime of
 * the page regardless of what its actual content becomes. `anchorFrom` and
 * `anchorTo` are the same encoded bytes: a collapsed, zero-width range,
 * the same shape a "comment on this page" affordance would use even with
 * a real editor present.
 */
export function pageStartAnchor(fragment: Y.XmlFragment): {
  readonly anchorFrom: string;
  readonly anchorTo: string;
} {
  const relative = Y.createRelativePositionFromTypeIndex(fragment, 0);
  const encoded = encodeBase64(Y.encodeRelativePosition(relative));
  return { anchorFrom: encoded, anchorTo: encoded };
}

interface PlainNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly PlainNode[];
  readonly text?: string;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
}

function textRunsFrom(xmlText: Y.XmlText): PlainNode[] {
  const delta = xmlText.toDelta() as readonly {
    readonly insert?: unknown;
    readonly attributes?: Record<string, unknown>;
  }[];

  const runs: PlainNode[] = [];
  for (const op of delta) {
    if (typeof op.insert !== 'string' || op.insert === '') continue;
    const marks = Object.entries(op.attributes ?? {}).map(([type, value]) =>
      value === true ? { type } : { type, attrs: value as Record<string, unknown> },
    );
    runs.push({ type: 'text', text: op.insert, ...(marks.length > 0 ? { marks } : {}) });
  }
  return runs;
}

function nodesFrom(child: Y.XmlElement | Y.XmlText | Y.XmlHook): readonly PlainNode[] {
  if (child instanceof Y.XmlText) return textRunsFrom(child);
  if (!(child instanceof Y.XmlElement)) return [];

  const content = child.toArray().flatMap((grandchild) => nodesFrom(grandchild));
  const attrs = child.getAttributes();
  return [
    {
      type: child.nodeName,
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(content.length > 0 ? { content } : {}),
    },
  ];
}

/** Converts a page's synced `content` fragment into the plain-JSON shape
 *  `RichTextView`'s `sanitizeRichText` already knows how to walk. */
export function yjsFragmentToRichTextDocument(fragment: Y.XmlFragment): unknown {
  return { type: 'doc', content: fragment.toArray().flatMap((child) => nodesFrom(child)) };
}
