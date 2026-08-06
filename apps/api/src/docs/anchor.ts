import * as Y from 'yjs';
import { z } from 'zod';
import { errors } from '@taskflow/contracts';

/**
 * Comment/suggestion anchors (ai/phase-6-docs.md §3.6).
 *
 * ## What this file does NOT do
 *
 * It never resolves an anchor to a position, and never builds one. Both of
 * those need the live `Y.Doc` — `Y.createRelativePositionFromTypeIndex` to
 * build one from a selection, `Y.createAbsolutePositionFromRelativePosition`
 * to resolve one back for rendering — and `apps/api` has no live document,
 * by design (see `page-version.service.ts`'s own header on the identical
 * point for content in general). The BROWSER does both, over its own
 * connected `apps/collab` session, and sends the already-encoded bytes here.
 *
 * ## What this file DOES do
 *
 * Structural validation only: `Y.decodeRelativePosition` either parses the
 * bytes as a well-formed `RelativePosition` or throws — it does not require
 * a `Y.Doc` to do that, because a `RelativePosition` is self-contained
 * (a struct ID plus an optional type-lookup path), not a pointer resolved
 * against live state. This is the identical "shape only, never meaning"
 * trust boundary `docs.yjs_updates.data` already has (migration 0024's own
 * header): the server confirms the bytes are A relative position, never
 * WHICH character one names, exactly as it never decodes what a WAL row's
 * bytes edit.
 */

/** Wire encoding for a client-supplied anchor — see the file header. */
export const AnchorSchema = z.string().base64('Anchor must be base64-encoded.').max(2_000);

/** Decodes and structurally validates a wire anchor, or throws VALIDATION_FAILED. */
export function decodeAnchor(wire: string): Buffer {
  const bytes = Buffer.from(wire, 'base64');

  try {
    Y.decodeRelativePosition(new Uint8Array(bytes));
  } catch {
    throw errors.validation({ field: 'anchor' }, 'Malformed anchor.');
  }

  return bytes;
}

/** Encodes a Buffer read back from storage for the wire — the inverse of decodeAnchor. */
export function encodeAnchor(bytes: Buffer): string {
  return bytes.toString('base64');
}
