/**
 * A dependency-free base64 codec — no `react-native` import, no `Buffer`,
 * no `atob`/`btoa`. `session.ts`'s JWT decode already leans on a global
 * `atob` and it works, but nothing in this codebase has ever needed to
 * ENCODE base64 on-device before (every other outgoing base64 payload —
 * uploads, attachments — is bytes over `multipart/form-data`, not a base64
 * string). Rather than assume `btoa` exists too (unverified in this
 * environment, no device to confirm it against, and the one native-runtime
 * assumption this session already got wrong cost a full rebuild cycle),
 * this is the standard base64 algorithm, written out — the same trade
 * `docs-collab.ts`'s Yjs walk makes for "tested against real structures"
 * over "trust the platform."
 *
 * Two callers: `docs-collab.ts`'s `pageStartAnchor` needs `encodeBase64`
 * (Yjs relative-position bytes, outgoing to `docs.comments.create`); a PDF
 * export's save-to-disk step needs `decodeBase64` (the server's
 * `contentBase64` response, incoming). Neither needs the other direction,
 * but both live here rather than as two one-off implementations.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const hasB1 = index + 1 < bytes.length;
    const hasB2 = index + 2 < bytes.length;
    const b1 = hasB1 ? (bytes[index + 1] ?? 0) : 0;
    const b2 = hasB2 ? (bytes[index + 2] ?? 0) : 0;

    const triplet = (b0 << 16) | (b1 << 8) | b2;
    // The four indices below are always in [0, 63] — `CHARS` has exactly 64
    // characters — so `?? ''` is a type-level guard for
    // `noUncheckedIndexedAccess` only, never actually reachable.
    result += CHARS[(triplet >> 18) & 0x3f] ?? '';
    result += CHARS[(triplet >> 12) & 0x3f] ?? '';
    result += hasB1 ? (CHARS[(triplet >> 6) & 0x3f] ?? '') : '=';
    result += hasB2 ? (CHARS[triplet & 0x3f] ?? '') : '=';
  }
  return result;
}

export function decodeBase64(value: string): Uint8Array {
  // Padding ('=') is stripped explicitly, BEFORE the whitelist filter — an
  // indexOf-based lookup treats a missing character and a genuinely absent
  // one identically (`CHARS.indexOf('')` returns 0, not -1, so a naive
  // "still in the whitelist" filter that dropped '=' along with everything
  // else made the last group's padding indistinguishable from real data).
  const withoutPadding = value.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  const bytes: number[] = [];

  for (let index = 0; index < withoutPadding.length; index += 4) {
    const c0chr = withoutPadding[index];
    const c1chr = withoutPadding[index + 1];
    const c2chr = withoutPadding[index + 2];
    const c3chr = withoutPadding[index + 3];
    const c0 = c0chr === undefined ? -1 : CHARS.indexOf(c0chr);
    const c1 = c1chr === undefined ? -1 : CHARS.indexOf(c1chr);
    const c2 = c2chr === undefined ? -1 : CHARS.indexOf(c2chr);
    const c3 = c3chr === undefined ? -1 : CHARS.indexOf(c3chr);

    const triplet =
      ((c0 < 0 ? 0 : c0) << 18) |
      ((c1 < 0 ? 0 : c1) << 12) |
      ((c2 < 0 ? 0 : c2) << 6) |
      (c3 < 0 ? 0 : c3);
    bytes.push((triplet >> 16) & 0xff);
    if (c2 >= 0) bytes.push((triplet >> 8) & 0xff);
    if (c3 >= 0) bytes.push(triplet & 0xff);
  }

  return new Uint8Array(bytes);
}
