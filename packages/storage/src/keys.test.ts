import { describe, expect, it } from 'vitest';
import { isGeneratedKey, newStorageKey, orgOfKey, safeDispositionName } from './keys.js';

/**
 * Object key generation (PLAN.md §8.4).
 *
 * The property under test: **no part of a key can come from a client**. A
 * client-supplied key is path traversal and a cross-tenant overwrite in one
 * field, and it looks entirely reasonable in a request body.
 */

const ORG = '0195cc00-0000-7000-8000-00000000000a';

describe('newStorageKey', () => {
  it('produces a key that only this system could have generated', () => {
    const key = newStorageKey(ORG);

    expect(isGeneratedKey(key)).toBe(true);
    expect(orgOfKey(key)).toBe(ORG);
  });

  it('never repeats, even within the same millisecond', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => newStorageKey(ORG)));
    expect(keys.size).toBe(1000);
  });

  it('recognizes the rtc recording shape, which is generated elsewhere', () => {
    /* `rtc/recording.service.ts` builds its own key rather than calling
       `newStorageKey`, because a capture is filed under the SESSION it belongs
       to. That was invisible for as long as recordings skipped `verifyUpload`
       entirely; wiring them into the scanner made `isGeneratedKey` the
       function that would otherwise have refused every one of them. */
    const session = '0195cc00-0000-7000-8000-00000000000b';
    const recording = '0195cc00-0000-7000-8000-00000000000c';
    const key = `rtc/${ORG}/${session}/${recording}.webm`;

    expect(isGeneratedKey(key)).toBe(true);
    expect(orgOfKey(key)).toBe(ORG);
  });

  it('still refuses anything that is not one of the two generated shapes', () => {
    // The point of the function is unchanged by adding a second shape: a key
    // that came from anywhere but this system must not reach the storage client.
    for (const key of [
      'uploads/photo.png',
      '../../etc/passwd',
      `rtc/${ORG}/not-a-uuid/x.webm`,
      `rtc/${ORG}/${ORG}/${ORG}.exe`,
      `org/${ORG}/2026/08/${ORG}/extra`,
      '',
    ]) {
      expect(isGeneratedKey(key)).toBe(false);
    }
  });

  it('partitions by org and month, so lifecycle rules are prefix operations', () => {
    const key = newStorageKey(ORG, new Date(Date.UTC(2026, 6, 29)));
    expect(key.startsWith(`org/${ORG}/2026/07/`)).toBe(true);
  });

  it('contains nothing derived from a filename', () => {
    // The original name lives in the database and is applied on download via
    // Content-Disposition. A name in the key would need path escaping, and
    // getting that wrong is the traversal this design removes.
    const key = newStorageKey(ORG);
    expect(key).not.toMatch(/\.(png|pdf|txt)$/);
  });
});

describe('isGeneratedKey', () => {
  it('rejects traversal attempts', () => {
    expect(isGeneratedKey('../../../etc/passwd')).toBe(false);
    expect(isGeneratedKey(`org/${ORG}/2026/07/../../../../secrets`)).toBe(false);
    expect(isGeneratedKey('org/../other/2026/07/abc')).toBe(false);
  });

  it('rejects a key that merely looks plausible', () => {
    expect(isGeneratedKey('uploads/photo.png')).toBe(false);
    expect(isGeneratedKey(`org/${ORG}/photo.png`)).toBe(false);
    expect(isGeneratedKey('')).toBe(false);
  });
});

describe('orgOfKey', () => {
  it('returns null for anything not matching the scheme', () => {
    expect(orgOfKey('uploads/photo.png')).toBeNull();
    expect(orgOfKey('')).toBeNull();
  });
});

describe('safeDispositionName', () => {
  it('removes the characters that would break out of the header', () => {
    /* A newline in a header is response splitting; a quote ends the
       quoted-string early and turns the rest of the name into parameters. */
    expect(safeDispositionName('re"port.pdf')).toBe('report.pdf');
    expect(safeDispositionName('a\r\nX-Evil: 1.pdf')).toBe('aX-Evil: 1.pdf');
    expect(safeDispositionName('back\\slash.txt')).toBe('backslash.txt');
    expect(safeDispositionName('nul\u0000byte.txt')).toBe('nulbyte.txt');
  });

  it('falls back to a usable name when nothing survives', () => {
    expect(safeDispositionName('"""')).toBe('download');
    expect(safeDispositionName('   ')).toBe('download');
  });

  it('keeps ordinary names, including non-ASCII', () => {
    // The ASCII fallback is allowed to be lossy; callers also emit the RFC 5987
    // `filename*` form. What matters is that it cannot break the header.
    expect(safeDispositionName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
    expect(safeDispositionName('résumé.pdf')).toBe('résumé.pdf');
  });

  it('bounds the length', () => {
    expect(safeDispositionName('a'.repeat(500))).toHaveLength(200);
  });
});
