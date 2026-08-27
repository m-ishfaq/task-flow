import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64.js';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('encodeBase64', () => {
  it('matches known vectors', () => {
    expect(encodeBase64(bytesOf(''))).toBe('');
    expect(encodeBase64(bytesOf('f'))).toBe('Zg==');
    expect(encodeBase64(bytesOf('fo'))).toBe('Zm8=');
    expect(encodeBase64(bytesOf('foo'))).toBe('Zm9v');
    expect(encodeBase64(bytesOf('foob'))).toBe('Zm9vYg==');
    expect(encodeBase64(bytesOf('fooba'))).toBe('Zm9vYmE=');
    expect(encodeBase64(bytesOf('foobar'))).toBe('Zm9vYmFy');
  });

  it('handles arbitrary byte values, not just printable ASCII', () => {
    expect(encodeBase64(new Uint8Array([0, 255, 128, 1]))).toBe('AP+AAQ==');
  });
});

describe('decodeBase64', () => {
  it('inverts encodeBase64 for every padding case', () => {
    for (const text of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const bytes = bytesOf(text);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  it('round-trips arbitrary byte values', () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 254, 17, 92]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
