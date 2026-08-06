import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AnchorSchema, decodeAnchor, encodeAnchor } from './anchor.js';

/**
 * Anchor validation (ai/phase-6-docs.md §3.6) — structural only, per the
 * file's own header: this never proves an anchor resolves to real content,
 * only that the bytes are a well-formed `Y.RelativePosition`.
 */

function realAnchor(): string {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, 'hello world');
  const relative = Y.createRelativePositionFromTypeIndex(text, 5);
  return encodeAnchor(Buffer.from(Y.encodeRelativePosition(relative)));
}

describe('AnchorSchema', () => {
  it('accepts a real, base64-encoded RelativePosition', () => {
    expect(AnchorSchema.safeParse(realAnchor()).success).toBe(true);
  });

  it('rejects non-base64 text', () => {
    expect(AnchorSchema.safeParse('not base64 at all!! 🎉').success).toBe(false);
  });
});

describe('decodeAnchor', () => {
  it('round-trips a real anchor', () => {
    const wire = realAnchor();
    expect(() => decodeAnchor(wire)).not.toThrow();
  });

  it('rejects an empty buffer', () => {
    expect(() => decodeAnchor('')).toThrow(/Malformed anchor/);
  });

  it('rejects truncated garbage that is not a valid RelativePosition encoding', () => {
    // A single byte is never enough to satisfy readRelativePosition's own
    // decode (it needs at least the leading varuint discriminant).
    const wire = Buffer.from([0xff]).toString('base64');
    expect(() => decodeAnchor(wire)).toThrow(/Malformed anchor/);
  });

  it('carries the VALIDATION_FAILED error code', () => {
    try {
      decodeAnchor('');
      expect.fail('expected decodeAnchor to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('encodeAnchor', () => {
  it('is the inverse of decodeAnchor', () => {
    const wire = realAnchor();
    const decoded = decodeAnchor(wire);
    expect(encodeAnchor(decoded)).toBe(wire);
  });
});
