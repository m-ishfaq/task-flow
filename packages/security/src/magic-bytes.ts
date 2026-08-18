/**
 * Magic-byte content type verification (PLAN.md §8.4).
 *
 * Step two of the upload pipeline: `presigned PUT with type and size pinned ->
 * MAGIC-BYTE VERIFICATION ON CONFIRM -> ClamAV scan -> flagged downloadable`.
 *
 * ## What this defends against, precisely
 *
 * The presigned URL pins `Content-Type` into the signature, so storage refuses
 * a body sent with a different header. That sounds like it already solves the
 * problem, and it does not: it proves the client SAID `image/png` at both
 * steps, not that the bytes are a PNG. Uploading an HTML file while declaring
 * `image/png` satisfies the signature completely.
 *
 * Why that matters is the part worth stating. Attachments are served from a
 * separate origin with `Content-Disposition: attachment`, which is the real
 * control — but both of those are configuration, one CDN rule away from being
 * wrong, and the file lives for years. A stored HTML file that a browser is
 * ever persuaded to render is stored XSS with a permanent URL. Checking the
 * bytes means the file was never HTML in the first place.
 *
 * ## Why a hand-written table and not `file-type`
 *
 * The npm package is better at breadth. This is not trying to identify
 * arbitrary files — it is answering one question: "do these bytes match what
 * the uploader claimed?" for a CLOSED list of types the product accepts. A
 * dependency that guesses among two hundred formats widens what is accepted,
 * and adds a parser to the attack surface at exactly the point where untrusted
 * bytes first arrive.
 *
 * Anything not on the list below is rejected, including types this table
 * cannot describe.
 */

/** How many bytes the caller needs to read from the front of an object. */
export const MAGIC_BYTE_PREFIX_LENGTH = 64;

interface Signature {
  /** Byte sequence to match. */
  readonly bytes: readonly number[];
  /** Offset the sequence starts at. */
  readonly offset: number;
}

interface TypeRule {
  /** Any one signature matching is enough. JPEG and TIFF have several. */
  readonly signatures: readonly Signature[];
  /**
   * Extra check for container formats whose leading bytes are shared.
   *
   * ZIP is the case that forces this to exist: `.docx`, `.xlsx` and `.pptx`
   * are all ZIP archives, so the first four bytes cannot distinguish them from
   * each other or from a plain `.zip`.
   */
  readonly refine?: (prefix: Uint8Array) => boolean;
  /**
   * Whether a USER may attach a file of this type (`ACCEPTED_CONTENT_TYPES`).
   *
   * Defaults to true, and exists for the one type where the two questions
   * come apart. "Can this system verify these bytes against this declared
   * type" and "may a person upload one to a card" are different questions,
   * and they were the same field until call recordings needed the first
   * without the second: `video/webm` is produced by the server's own
   * recording flow, never chosen by an uploader, and adding it to the
   * attachment allowlist as a side effect of teaching the scanner about it
   * would have widened a product surface from inside a security fix.
   */
  readonly attachable?: boolean;
}

/**
 * The code units of an ASCII marker like `GIF89a`.
 *
 * Indexed rather than spread: spreading a string yields code POINTS, which is
 * the right thing for text and the wrong thing here — a signature is a
 * sequence of bytes, and every marker in this file is ASCII by construction.
 */
function ascii(text: string): readonly number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) bytes.push(text.charCodeAt(index));
  return bytes;
}

/** ZIP local file header — shared by every Office Open XML format. */
const ZIP_SIGNATURES: readonly Signature[] = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0 },
  // Empty and spanned archives. Present so a legitimate empty ZIP is not
  // reported as a type mismatch, which would be an unexplainable upload failure.
  { bytes: [0x50, 0x4b, 0x05, 0x06], offset: 0 },
  { bytes: [0x50, 0x4b, 0x07, 0x08], offset: 0 },
];

/**
 * The accepted types.
 *
 * Deliberately short. Every entry is a format the product actually renders or
 * offers for download, and adding one is a decision about what may be stored
 * and later handed to a browser — not a convenience.
 *
 * Note what is ABSENT: `image/svg+xml` and `text/html`. SVG is a document
 * format that can carry script, so it is an XSS vector wearing an image's
 * content type, and there is no byte signature that could tell a safe SVG from
 * a hostile one.
 */
const TYPE_RULES: Readonly<Record<string, TypeRule>> = {
  'image/png': {
    signatures: [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 }],
  },
  'image/jpeg': {
    signatures: [{ bytes: [0xff, 0xd8, 0xff], offset: 0 }],
  },
  'image/gif': {
    signatures: [
      { bytes: ascii('GIF87a'), offset: 0 },
      { bytes: ascii('GIF89a'), offset: 0 },
    ],
  },
  'image/webp': {
    // RIFF....WEBP — the size field sits between the two markers.
    signatures: [{ bytes: ascii('RIFF'), offset: 0 }],
    refine: (prefix) => matches(prefix, { bytes: ascii('WEBP'), offset: 8 }),
  },
  'application/pdf': {
    signatures: [{ bytes: ascii('%PDF-'), offset: 0 }],
  },
  /**
   * WebM, the container a browser's `MediaRecorder` produces for an in-app
   * call recording (`apps/web/src/features/rtc/call-recorder.ts`).
   *
   * The signature is the EBML header — `1A 45 DF A3` — which WebM shares with
   * Matroska, since WebM is a profile of it. Refined by looking for the
   * `webm` DocType marker in the prefix rather than at a fixed offset: the
   * EBML header's fields are variable-length, so the marker's position moves
   * with the encoder that wrote it. That is weaker than a fixed-offset check
   * and stronger than the four-byte header alone, which would accept any
   * Matroska file — an honest middle, and the virus scan is the layer that
   * does not care about container semantics either way.
   */
  'video/webm': {
    signatures: [{ bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0 }],
    refine: (prefix) => containsMarker(prefix, ascii('webm')),
    /* Verifiable, deliberately not attachable — see `attachable`'s own note. */
    attachable: false,
  },
  'application/zip': {
    signatures: ZIP_SIGNATURES,
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    signatures: ZIP_SIGNATURES,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    signatures: ZIP_SIGNATURES,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    signatures: ZIP_SIGNATURES,
  },
  /**
   * Plain text has no magic bytes, which is exactly why it needs a rule rather
   * than an exemption. The check is a NEGATIVE one: the prefix must not look
   * like anything else, and must not contain a NUL byte — the cheapest reliable
   * signal that a file is binary pretending to be text.
   */
  'text/plain': {
    signatures: [],
    refine: (prefix) => !prefix.includes(0x00) && !looksLikeMarkup(prefix),
  },
  'text/csv': {
    signatures: [],
    refine: (prefix) => !prefix.includes(0x00) && !looksLikeMarkup(prefix),
  },
  /**
   * Same negative check as the other text types, not a JSON parse — this
   * function only ever sees the first `MAGIC_BYTE_PREFIX_LENGTH` bytes, and a
   * truncated prefix is not valid JSON on its own even for a genuine file, so
   * `JSON.parse` would reject good uploads as often as bad ones. What actually
   * matters here is the same thing it is for `text/plain`: reject a binary
   * file (a NUL byte) or one that opens with markup wearing a `.json` name.
   */
  'application/json': {
    signatures: [],
    refine: (prefix) => !prefix.includes(0x00) && !looksLikeMarkup(prefix),
  },
};

/** Every content type an upload may declare. */
/**
 * The types a USER may upload as an attachment.
 *
 * A subset of what `verifyMagicBytes` can check — see `TypeRule.attachable`.
 */
export const ACCEPTED_CONTENT_TYPES: readonly string[] = Object.entries(TYPE_RULES)
  .filter(([, rule]) => rule.attachable !== false)
  .map(([contentType]) => contentType);

export function isAcceptedContentType(contentType: string): boolean {
  return Object.hasOwn(TYPE_RULES, contentType) && TYPE_RULES[contentType]?.attachable !== false;
}

/**
 * True when the prefix begins with something a browser might treat as markup.
 *
 * Only used for the text types, where there is no positive signature to check.
 * A `.txt` file whose first bytes are `<!DOCTYPE html>` is the exact payload
 * this whole module exists to keep out of storage.
 */
function looksLikeMarkup(prefix: Uint8Array): boolean {
  let index = 0;
  // Skip a UTF-8 BOM and leading whitespace, both of which a browser also
  // skips before deciding it is looking at HTML.
  if (prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) index = 3;
  while (index < prefix.length && isWhitespace(prefix[index])) index += 1;

  return prefix[index] === 0x3c; // '<'
}

function isWhitespace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c;
}

function matches(prefix: Uint8Array, signature: Signature): boolean {
  if (prefix.length < signature.offset + signature.bytes.length) return false;

  for (const [index, byte] of signature.bytes.entries()) {
    if (prefix[signature.offset + index] !== byte) return false;
  }
  return true;
}

/**
 * Whether a byte sequence appears anywhere in the prefix.
 *
 * For formats whose distinguishing marker sits at a position the container
 * itself decides — EBML's DocType, whose offset moves with the variable-length
 * fields ahead of it. Scanning is deliberately confined to the prefix
 * (`MAGIC_BYTE_PREFIX_LENGTH`), so this stays a bounded read over bytes the
 * caller has already fetched, not a search of the whole object.
 */
function containsMarker(prefix: Uint8Array, marker: readonly number[]): boolean {
  if (marker.length === 0 || prefix.length < marker.length) return false;

  for (let start = 0; start <= prefix.length - marker.length; start += 1) {
    let hit = true;
    for (const [index, byte] of marker.entries()) {
      if (prefix[start + index] !== byte) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

export interface SniffResult {
  readonly ok: boolean;
  /** Why it failed, for the audit trail. Never returned to the uploader verbatim. */
  readonly reason?: string;
}

/**
 * Checks that `prefix` is consistent with `declaredType`.
 *
 * Takes the first bytes rather than a stream, so the caller decides how much to
 * read and this stays a pure function — which is what makes it testable against
 * hostile inputs without any storage at all.
 *
 * Returns a result rather than throwing: a type mismatch is an expected outcome
 * of an upload, not an exceptional one, and the caller records it on the row.
 */
export function verifyMagicBytes(declaredType: string, prefix: Uint8Array): SniffResult {
  const rule = TYPE_RULES[declaredType];

  // An unlisted type never gets here in normal operation — presign refuses it —
  // but a row created before the list changed would. Fail closed.
  if (!rule) return { ok: false, reason: `Content type ${declaredType} is not accepted.` };

  if (prefix.length === 0) return { ok: false, reason: 'The uploaded object is empty.' };

  if (rule.signatures.length > 0 && !rule.signatures.some((sig) => matches(prefix, sig))) {
    return { ok: false, reason: `Contents do not match the declared type ${declaredType}.` };
  }

  if (rule.refine && !rule.refine(prefix)) {
    return { ok: false, reason: `Contents do not match the declared type ${declaredType}.` };
  }

  return { ok: true };
}
