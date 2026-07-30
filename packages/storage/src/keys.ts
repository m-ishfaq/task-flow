import { newId } from '@taskflow/security';

/**
 * Object key generation (PLAN.md §8.4).
 *
 * The whole point of this file is that **no part of a storage key comes from a
 * client**. A client-supplied key is a path traversal and an overwrite of
 * another tenant's object in one field, and it looks completely reasonable in a
 * request body — `{ key: "uploads/photo.png" }` is what every naive upload API
 * accepts.
 *
 * So the key is built from an org id and a fresh UUIDv7, and the original
 * filename is stored in the DATABASE rather than in the key. Downloads set it
 * with `Content-Disposition`, which is where a filename belongs — a name in the
 * key would have to be escaped for a path, and getting that wrong is the
 * traversal this design removes rather than mitigates.
 */

/**
 * The key for a new upload.
 *
 * Shape: `org/<orgId>/<yyyy>/<mm>/<uuid>`.
 *
 * The org prefix is not a security boundary — RLS and the attachments table are
 * — but it makes a per-tenant lifecycle rule, a per-tenant usage total, and a
 * crypto-shred deletion expressible as a prefix operation instead of a scan.
 * The date segments keep any single prefix from accumulating millions of
 * objects, which some backends list poorly.
 */
export function newStorageKey(orgId: string, at: Date = new Date()): string {
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');

  /* `newId` is UUIDv7 from @taskflow/security — CSPRNG-backed and
     time-sortable. A predictable key would let someone who learns the scheme
     guess another tenant's object names, and while a guessed key still needs a
     presigned URL to fetch, "unguessable" is free here. */
  return `org/${orgId}/${year}/${month}/${newId<'AttachmentId'>()}`;
}

/**
 * True when a key is one this system generated.
 *
 * Checked before every storage operation that takes a key from a database row.
 * That sounds redundant — the row was written by `newStorageKey` — and it is
 * the cheap backstop for the case that matters: if a key ever DID arrive from
 * outside and reach a row, this is what stops it being handed to the storage
 * client afterwards. Defence in depth on the one field where a mistake is a
 * cross-tenant read.
 */
export function isGeneratedKey(key: string): boolean {
  return /^org\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/i.test(key);
}

/**
 * The org a key belongs to, or null.
 *
 * Used to assert that a key read from a row belongs to the org the request is
 * scoped to. RLS already guarantees it; this catches the case where a key was
 * copied between rows by a bug rather than by an attacker.
 */
export function orgOfKey(key: string): string | null {
  const match = /^org\/([0-9a-f-]{36})\//i.exec(key);
  return match?.[1] ?? null;
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * Returns the ASCII fallback; callers should also emit the RFC 5987 `filename*`
 * form for the original. Quotes, backslashes, control characters and newlines
 * are removed because a newline in a header is response splitting, and a quote
 * ends the quoted-string early and lets the rest of the name become header
 * parameters.
 */
export function safeDispositionName(filename: string): string {
  /* Filtered by code point rather than by a regex, because a regex containing
     a control-character range trips `no-control-regex` — and the honest fix
     there is to not write the regex, not to silence the rule. */
  let stripped = '';
  for (let index = 0; index < filename.length; index += 1) {
    const code = filename.charCodeAt(index);
    const isControl = code <= 0x1f || code === 0x7f;
    const isDelimiter = code === 0x22 || code === 0x5c; // '"' and '\'
    if (!isControl && !isDelimiter) stripped += filename.charAt(index);
  }

  const trimmed = stripped.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : 'download';
}
