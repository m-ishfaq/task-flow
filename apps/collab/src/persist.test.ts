import { describe, expect, it } from 'vitest';
import { OutgoingMessage } from '@hocuspocus/server';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1, writeSyncStep2 } from 'y-protocols/sync';
import { extractUpdateBytes } from './persist.js';

/**
 * `extractUpdateBytes` (ai/phase-6-docs.md §3.7) — the peek that decides
 * what gets written to the WAL, and it has to agree with the real protocol
 * exactly, not a guess at its shape.
 *
 * Every fixture is built with the real wire-format primitives: Hocuspocus's
 * own `OutgoingMessage` for what it exposes directly (an update message, an
 * awareness query), and `y-protocols/sync`'s own `writeSyncStep1`/
 * `writeSyncStep2` — the exact functions the real server calls — combined
 * with `lib0/encoding` for the two-field envelope (document name, then
 * Hocuspocus's `MessageType.Sync = 0`) that OutgoingMessage doesn't expose a
 * direct method for. None of this is a hand-rolled reinterpretation of the
 * format; it is the library's own encoder, exercised the same way the real
 * client and server exercise it.
 */

function syncEnvelope(
  documentName: string,
  writeInner: (encoder: encoding.Encoder) => void,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, 0); // MessageType.Sync
  writeInner(encoder);
  return encoding.toUint8Array(encoder);
}

describe('extractUpdateBytes', () => {
  it('extracts the update bytes from a real messageYjsUpdate message', () => {
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    const raw = new OutgoingMessage('page:test')
      .createSyncMessage()
      .writeUpdate(update)
      .toUint8Array();

    expect(extractUpdateBytes(raw)).toEqual(update);
  });

  it('extracts the update bytes from a real messageYjsSyncStep2 message', () => {
    const source = new Y.Doc();
    source.getXmlFragment('content').insert(0, [new Y.XmlText('hi')]);

    const raw = syncEnvelope('page:test', (encoder) => {
      writeSyncStep2(encoder, source, undefined);
    });

    const extracted = extractUpdateBytes(raw);
    expect(extracted).not.toBeNull();

    // Prove it is REPLAYABLE, not merely byte-shaped: applying it to a fresh
    // doc must converge to the same content the source had.
    const replay = new Y.Doc();
    Y.applyUpdate(replay, extracted!);
    // YXmlFragment.prototype.toString genuinely serializes to XML-like text
    // at runtime (confirmed directly in yjs's compiled output — line 7784 of
    // dist/yjs.cjs at the time of writing: `typeListMap(this, xml =>
    // xml.toString()).join('')`), but Yjs's own .d.ts declares no override
    // for it, so eslint's type-aware no-base-to-string sees only
    // Object.prototype.toString and flags it. A confirmed upstream types
    // gap, not a real Object.prototype.toString call.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(replay.getXmlFragment('content').toString()).toBe(
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      source.getXmlFragment('content').toString(),
    );
  });

  it('skips a messageYjsSyncStep1 message — a state request, not a delta', () => {
    const raw = syncEnvelope('page:test', (encoder) => {
      writeSyncStep1(encoder, new Y.Doc());
    });

    expect(extractUpdateBytes(raw)).toBeNull();
  });

  it('skips a non-sync message (awareness query)', () => {
    const raw = new OutgoingMessage('page:test').writeQueryAwareness().toUint8Array();

    expect(extractUpdateBytes(raw)).toBeNull();
  });

  it('does not disturb a second, independent read of the same bytes', () => {
    // The whole safety argument for peeking with a fresh IncomingMessage: the
    // real receiver decodes the SAME immutable bytes afterward and must see
    // them exactly as sent, unaffected by this function's own read.
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    const raw = new OutgoingMessage('page:test')
      .createSyncMessage()
      .writeUpdate(update)
      .toUint8Array();

    const first = extractUpdateBytes(raw);
    const second = extractUpdateBytes(raw);
    expect(first).toEqual(second);
  });
});
