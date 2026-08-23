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

export interface PlainNode {
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

/**
 * `writeRichTextDocumentToFragment` — the inverse of
 * `yjsFragmentToRichTextDocument`, and the piece that makes
 * `docs-page-editor.ts` a real WRITE path rather than only a read one.
 * Replaces a page's ENTIRE `content` fragment with a fresh tree built from
 * plain JSON (`rich-text-compose.ts`'s `parseFormattedText` output) — a
 * whole-document overwrite, not a live per-keystroke edit; see
 * `docs-page-editor.ts`'s own header for why that is the honest scope
 * here, not "the same as web."
 *
 * ## Attach-then-fill, not build-then-attach
 *
 * `Y.XmlText.insert()` needs the text to already be reachable from the
 * document root before it will accept content — confirmed directly by
 * this file's own tests (`docs-collab.test.ts` builds every fixture
 * `parent.insert(0, [child]); child.insert(0, 'text')`, never the reverse)
 * and by Yjs's own CRDT model, where an operation needs a client id and
 * document context a detached type does not have. `Y.XmlElement.
 * setAttribute` has no such requirement (every existing test sets
 * attributes BEFORE attaching). `buildInto` below follows that order
 * exactly: construct an element, set its attributes, ATTACH it to its
 * now-attached parent, and only then recurse into building ITS children —
 * so by the time any `Y.XmlText` is reached, the whole chain back to the
 * root `fragment` (already attached, since it came from `doc.getXmlFragment
 * ('content')`) is attached too.
 *
 * ## One `Y.XmlText` per run of consecutive text nodes, not one per mark
 *
 * Mirrors `textRunsFrom`'s own read-side assumption (a `Y.XmlText.
 * toDelta()` naturally groups multiple marked runs as sequential inserts
 * into ONE text instance) rather than one `Y.XmlText` per run — an atomic
 * inline node (`mention`, `pageLink`) breaks a run and starts a new one,
 * exactly the shape `docs-collab.test.ts`'s own mention fixture already
 * builds by hand.
 *
 * ## One transaction, so no connected viewer sees a flash of "empty page"
 *
 * `doc.transact(...)` is what makes the delete-then-rebuild ONE Yjs
 * update, not two — a viewer connected to the same page (including this
 * same client's own `observeDeep` handler in `docs-page/[pageId].tsx`)
 * observes the FINAL state once, never an intermediate "content cleared"
 * frame.
 */
function setRawAttribute(element: Y.XmlElement, key: string, value: unknown): void {
  // `YXmlElement<KV>`'s own type defaults an attribute's value to `string`
  // when no generic is supplied — this app writes numbers (`heading
  // .level`, `orderedList.start`), booleans (`taskItem.checked`), and
  // nullable strings (`codeBlock.language`) too, none of which Yjs itself
  // restricts at runtime; only the ambient TS type does. Cast once, here,
  // rather than at every call site — the identical trade
  // `docs-collab.test.ts`'s own header already documents for its heading
  // fixture, promoted from a test-only pattern to the real writer.
  (
    element as unknown as { setAttribute: (attributeName: string, attributeValue: unknown) => void }
  ).setAttribute(key, value);
}

/**
 * ALWAYS returns a real object, never `undefined` — found live, by this
 * function's own round-trip test: `Y.XmlText.insert(index, text,
 * attributes)` treats a MISSING third argument as "inherit whatever
 * formatting is already active at this position," not "no formatting."
 * Two marked runs separated by plain text (`**bold**, *italic*`) written
 * with `undefined` for the plain middle run came back merged into the
 * FIRST run's own bold mark, silently bolding text that was never marked
 * — confirmed against real Yjs, not assumed from the type signature (`?:
 * Object | undefined` reads as "optional == no formatting," and is not).
 * `{}` is the explicit "clear formatting here" this API actually needs.
 */
function attributesFromMarks(
  marks: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[] | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const mark of marks ?? []) attributes[mark.type] = mark.attrs ?? true;
  return attributes;
}

function buildInto(parent: Y.XmlFragment | Y.XmlElement, nodes: readonly PlainNode[]): void {
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) {
      index += 1;
      continue;
    }

    if (node.type === 'text') {
      const textNode = new Y.XmlText();
      parent.insert(parent.length, [textNode]);
      let offset = 0;
      while (index < nodes.length) {
        const run = nodes[index];
        if (run?.type !== 'text') break;
        const runText = run.text ?? '';
        textNode.insert(offset, runText, attributesFromMarks(run.marks));
        offset += runText.length;
        index += 1;
      }
      continue;
    }

    const element = new Y.XmlElement(node.type);
    for (const [key, value] of Object.entries(node.attrs ?? {}))
      setRawAttribute(element, key, value);
    parent.insert(parent.length, [element]);
    if (node.content !== undefined) buildInto(element, node.content);
    index += 1;
  }
}

export function writeRichTextDocumentToFragment(
  fragment: Y.XmlFragment,
  document: { readonly content: readonly PlainNode[] },
): void {
  const run = (): void => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    buildInto(fragment, document.content);
  };

  const doc = fragment.doc;
  if (doc === null) {
    run();
    return;
  }
  doc.transact(run);
}
