import * as Y from 'yjs';
import type { Editor } from '@tiptap/react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  type ProsemirrorBinding,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';

/**
 * Comment/suggestion anchors — the BROWSER half (ai/phase-6-docs.md §3.6).
 *
 * `apps/api/src/docs/anchor.ts`'s own header explains why the server never
 * builds or resolves one: both directions need the live `Y.Doc`, which only
 * the browser (connected through `apps/collab`) ever holds. This file is
 * that half — a thin wrapper over `@tiptap/y-tiptap`'s
 * `absolutePositionToRelativePosition` / `relativePositionToAbsolutePosition`,
 * the same conversion `Collaboration`'s own cursor/selection sync uses
 * internally, applied here to comment and suggestion anchors instead of
 * caret positions.
 *
 * ## Where the mapping comes from
 *
 * `ySyncPluginKey.getState(editor.state)` is how `@tiptap/extension-
 * collaboration`'s underlying `ySyncPlugin` exposes its live
 * `ProsemirrorBinding` — the `mapping` between ProseMirror positions and Yjs
 * types both conversion functions need, and the same object `Collaboration`
 * itself reads from on every transaction. This state only exists once
 * `Collaboration` has mounted, which is guaranteed here because this module
 * is only ever called from `docs-editor.tsx`'s `DocsEditorReady` — never
 * from the `provider === null` render `DocsEditor` shows before that.
 *
 * ## Base64, not `Buffer`
 *
 * `apps/api/src/docs/anchor.ts` encodes with Node's `Buffer`; there is no
 * `Buffer` in the browser bundle (confirmed against this app's one other
 * base64 use, `lib/session.ts`'s JWT decode, which uses `atob`). Ordinary
 * base64 is base64 regardless of which side encodes it, so the wire format
 * — and `AnchorSchema`'s validation of it — is unaffected.
 */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface YSyncPluginState {
  readonly binding: InstanceType<typeof ProsemirrorBinding> | null;
}

function bindingOf(editor: Editor): InstanceType<typeof ProsemirrorBinding> | null {
  const state = ySyncPluginKey.getState(editor.state) as YSyncPluginState | undefined;
  return state?.binding ?? null;
}

function contentFragment(provider: HocuspocusProvider): Y.XmlFragment {
  // MUST be the same field `Collaboration.configure({ field: 'content' })`
  // binds to (docs-editor.tsx's own header) — a mismatch here would build an
  // anchor against a fragment nothing renders.
  return provider.document.getXmlFragment('content');
}

/**
 * Builds a wire anchor (base64 `Y.RelativePosition`) at a ProseMirror
 * absolute position. `null` means the editor has no live Yjs binding yet —
 * callers should treat that as "try again once connected", not as an error.
 */
export function buildAnchor(
  editor: Editor,
  provider: HocuspocusProvider,
  pos: number,
): string | null {
  const binding = bindingOf(editor);
  if (binding === null) return null;

  const relative = absolutePositionToRelativePosition(
    pos,
    contentFragment(provider),
    binding.mapping,
  ) as Y.RelativePosition;

  return toBase64(Y.encodeRelativePosition(relative));
}

/**
 * The current selection's `[from, to]` as wire anchors — `null` if there is
 * no live binding yet, or the selection is collapsed (a comment/suggestion
 * needs a real range to anchor to).
 */
export function buildSelectionAnchor(
  editor: Editor,
  provider: HocuspocusProvider,
): { readonly from: string; readonly to: string } | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;

  const anchorFrom = buildAnchor(editor, provider, from);
  const anchorTo = buildAnchor(editor, provider, to);
  if (anchorFrom === null || anchorTo === null) return null;

  return { from: anchorFrom, to: anchorTo };
}

/**
 * Resolves a wire anchor back to a ProseMirror absolute position against the
 * LIVE document. `null` means the anchor no longer resolves — the anchored
 * text was deleted, the bytes are malformed, or the binding is not ready —
 * and callers should render "this text is no longer available" rather than
 * guessing a position.
 */
export function resolveAnchor(
  editor: Editor,
  provider: HocuspocusProvider,
  wireAnchor: string,
): number | null {
  const binding = bindingOf(editor);
  if (binding === null) return null;

  let relative: Y.RelativePosition;
  try {
    relative = Y.decodeRelativePosition(fromBase64(wireAnchor));
  } catch {
    return null;
  }

  return relativePositionToAbsolutePosition(
    provider.document,
    contentFragment(provider),
    relative,
    binding.mapping,
  );
}
