/**
 * The embedded-reference convention the assistant's composer uses to hand
 * the model an ALREADY-RESOLVED id, rather than a name it has to look up
 * itself. Found necessary from a direct request: the whole point of adding
 * `@`/`#`/`&`/`%`/`~` mention pickers to the assistant's input is "zero
 * error" — and a picker that only inserts a display string ("@Priya
 * Nakamura") still leaves the MODEL to independently resolve that string
 * back to a real id via `list_members`, which is exactly the step that can
 * still go wrong (two members sharing a display name, a stale re-fetch, a
 * misread). Embedding the id directly removes that step entirely for
 * anything the person picked from a real list.
 *
 * `Label{{type:id}}` is a plain-text suffix, not a wire-format change —
 * `ai.chat.send`'s `content` stays an ordinary string, so nothing about
 * `ChatMessageWire`, the server's Zod schemas, or the assistant's
 * tool-calling loop needs to change. Only two things need to agree on the
 * convention: the composer, which WRITES it (`entity-mention-extension.ts`'s
 * `renderText`), and the system prompt (`router.ts`), which tells the model
 * to trust an id that arrives this way rather than re-resolving it. A third
 * consumer, `stripReferenceEmbeds`, is for DISPLAY only — a person's own
 * sent message should show "@Priya Nakamura", never the raw id sitting
 * behind it, in their own chat bubble.
 *
 * `{{type:uuid}}` (double curly braces, ASCII, requiring a real closed-enum
 * type and a real UUID shape inside) is deliberately over-specific rather
 * than a bare `{{...}}` — someone pasting a Handlebars-style template or a
 * MediaWiki-style `{{note}}` into a message must never have that text
 * silently eaten by the strip function meant only for what the picker
 * itself inserts.
 */

export const REFERENCE_TYPES = ['user', 'project', 'board', 'sprint', 'list'] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REFERENCE_TYPE_PATTERN = REFERENCE_TYPES.join('|');

/** Matches exactly what `encodeReference` produces — never a template or
    wiki-link string a person typed by hand. */
const EMBED_PATTERN = new RegExp(`\\{\\{(?:${REFERENCE_TYPE_PATTERN}):${UUID_PATTERN}\\}\\}`, 'g');

export function encodeReference(label: string, type: ReferenceType, id: string): string {
  return `${label}{{${type}:${id}}}`;
}

/** What a person should see for their OWN sent message — the label alone,
    with every embed suffix removed. Never applied to the assistant's own
    replies, which never contain one. */
export function stripReferenceEmbeds(text: string): string {
  return text.replaceAll(EMBED_PATTERN, '');
}
