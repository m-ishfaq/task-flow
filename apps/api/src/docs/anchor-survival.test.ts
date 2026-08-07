import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeAnchor, encodeAnchor } from './anchor.js';

/**
 * Proves the property §3.6 flags as "the single trickiest correctness point
 * in the phase": a comment's anchor survives a concurrent edit landing
 * BEFORE it, rather than silently drifting onto the wrong sentence.
 *
 * ## Why this is worth a dedicated file
 *
 * Storing a plain character offset would detach a comment from its text the
 * moment anyone edits anything before that offset — and that failure mode
 * is exactly the kind §3.6 warns about: "it doesn't error, doesn't fail a
 * test written against the wrong mental model, and doesn't show up until a
 * real editing session drifts a comment onto the wrong sentence." A test
 * asserting only that an anchor round-trips through `encodeAnchor`/
 * `decodeAnchor` unchanged (`anchor.test.ts` already does that) would pass
 * for a naive integer offset just as easily as for a real
 * `Y.RelativePosition` — it says nothing about survival under a concurrent
 * edit, which is the actual property this design depends on.
 *
 * ## Why this can be proven with no editor UI
 *
 * Creating and resolving an anchor both happen client-side, against a live
 * `Y.Doc` — `apps/api` never does either (`anchor.ts`'s own header). But the
 * PROPERTY under test belongs to Yjs's CRDT merge semantics, not to any
 * browser code: two independent `Y.Doc`s, synced only via `Y.applyUpdate`,
 * exhibit the identical merge behavior a real Hocuspocus session would.
 * `apps/collab/src/replay.test.ts` already established this same reasoning
 * for content replay; this file is the comment-anchoring analogue.
 */

/** A `Y.Doc` with one XmlText node holding `text`, the shape a real page body uses. */
function docWithText(text: string): { doc: Y.Doc; node: Y.XmlText } {
  const doc = new Y.Doc();
  const node = new Y.XmlText(text);
  doc.getXmlFragment('content').insert(0, [node]);
  return { doc, node };
}

function textOf(doc: Y.Doc): string {
  const node = doc.getXmlFragment('content').get(0) as Y.XmlText;
  // YXmlText.toString() is genuinely typed `any` (unlike YXmlFragment's,
  // which falls back to Object.prototype's and trips no-base-to-string
  // instead — see replay.test.ts's identical note on that variant). The
  // explicit String() call is what makes the return type honest either way.
  return String(node.toString());
}

describe('a comment anchor, under a concurrent edit', () => {
  it('shifts forward to stay on the same text when an edit lands BEFORE it', () => {
    // The writer's session: "Hello World".
    const writer = docWithText('Hello World');

    // A second client, synced to the writer's initial state — a real
    // Hocuspocus session opening the same page would look identical.
    const reader = new Y.Doc();
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));
    const readerNode = reader.getXmlFragment('content').get(0) as Y.XmlText;

    // The reader anchors a comment on "World" — index 6, right after "Hello ".
    // Encoded via this app's own encodeAnchor, the exact wire format
    // docs.comments.anchor_from actually stores.
    const relative = Y.createRelativePositionFromTypeIndex(readerNode, 6);
    const stored = encodeAnchor(Buffer.from(Y.encodeRelativePosition(relative)));

    // CONCURRENTLY — neither side has seen the other's op yet — the writer
    // prepends more text, pushing "World" further along the string.
    writer.node.insert(0, 'Really, really ');

    // The two sessions converge, exactly as two real Hocuspocus clients would.
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));
    Y.applyUpdate(writer.doc, Y.encodeStateAsUpdate(reader));
    expect(textOf(reader)).toBe(textOf(writer.doc));
    expect(textOf(reader)).toBe('Really, really Hello World');

    // Resolve the STORED anchor (round-tripped through this app's own
    // encode/decode, the exact bytes docs.comments.anchor_from would hold)
    // against the now-merged document.
    const resolved = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeAnchor(stored)),
      reader,
    );

    expect(resolved).not.toBeNull();
    // A stale plain offset would still read 6, landing inside "Really, ".
    // The relative position instead moved WITH "World".
    expect(resolved?.index).toBe('Really, really Hello '.length);
    expect(textOf(reader).slice(resolved?.index ?? 0)).toBe('World');
  });

  it('does NOT move when an edit lands AFTER it', () => {
    const writer = docWithText('Hello World');
    const reader = new Y.Doc();
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));
    const readerNode = reader.getXmlFragment('content').get(0) as Y.XmlText;

    // Anchor on "Hello" — index 0.
    const relative = Y.createRelativePositionFromTypeIndex(readerNode, 0);
    const stored = encodeAnchor(Buffer.from(Y.encodeRelativePosition(relative)));

    // An edit lands AFTER the anchor this time.
    writer.node.insert(writer.node.length, ', truly');
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));

    const resolved = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeAnchor(stored)),
      reader,
    );

    expect(resolved?.index).toBe(0);
    expect(textOf(reader).slice(resolved?.index ?? 0)).toBe('Hello World, truly');
  });

  it("a RANGE (anchor_from/anchor_to, matching docs.comments' actual pair) shifts consistently at both ends", () => {
    const writer = docWithText('Hello brave new world');
    const reader = new Y.Doc();
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));
    const readerNode = reader.getXmlFragment('content').get(0) as Y.XmlText;

    // Anchors the range "brave new" — indices 6 to 15.
    const from = encodeAnchor(
      Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(readerNode, 6))),
    );
    const to = encodeAnchor(
      Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(readerNode, 15))),
    );

    // A concurrent edit prepends text before the whole range.
    writer.node.insert(0, 'Oh, ');
    Y.applyUpdate(reader, Y.encodeStateAsUpdate(writer.doc));

    const resolvedFrom = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeAnchor(from)),
      reader,
    );
    const resolvedTo = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeAnchor(to)),
      reader,
    );

    const shift = 'Oh, '.length;
    expect(resolvedFrom?.index).toBe(6 + shift);
    expect(resolvedTo?.index).toBe(15 + shift);
    expect(textOf(reader).slice(resolvedFrom?.index, resolvedTo?.index)).toBe('brave new');
  });
});
