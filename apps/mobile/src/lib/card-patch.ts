import type { CardDetail, Priority } from './work.js';

/**
 * The pure half of card editing — no `@tanstack/react-query`, no
 * `apiClient`, no React at all. Split out of `use-update-card.ts`
 * specifically so it stays importable from a Vitest file with no native
 * runtime in its module graph: `apiClient` is built on `app-session.ts`,
 * which pulls in `react-native` itself, and Vitest's plain (non-Metro)
 * transform cannot parse that package's Flow-typed source — the same
 * "Expo-free and Vitest-safe" boundary `work.ts`'s own header already
 * draws, and the same split `rich-text.ts` (pure) / `rich-text-view.tsx`
 * (native-consuming) uses for the identical reason.
 *
 * `work.cards.update` is a FULL REPLACE — `description: null` clears it,
 * and omitting a field does the same, since the server schema defaults
 * every optional-looking field to `null` (`apps/api/src/work/router.ts`).
 * `mergePatch` is the "loaded gun" that fact creates: `'key' in patch`
 * (touched, possibly to `null`) versus the key being absent (untouched,
 * forward the current value) is the entire difference between an edit and
 * a silent field wipe, and `??` alone gets it backwards — `{ dueDate: null
 * }` would read as "not supplied" and restore the old date instead of
 * clearing it. Ported from `apps/web/src/features/work/use-update-card.ts`'s
 * identical `applyPatch`/`asRichText`.
 */

/**
 * A rich text document, as the API's `RichTextDocument` schema parses it.
 *
 * Structural rather than imported, mirroring web's identical `RichText`
 * type and its own reasoning: this only has to be honest about what is
 * being SENT, not tie the bundle's types to the server's validation module.
 * Unused today — this increment edits title and priority only, no native
 * rich text editor exists yet (`rich-text-view.tsx` only reads) — but kept
 * on `CardPatch` so a future description-editing screen is "add a UI
 * control", not "extend this hook's type".
 */
export interface RichText {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: unknown;
  readonly marks?: readonly unknown[] | undefined;
  readonly content?: readonly RichText[] | undefined;
}

export interface CardPatch {
  readonly title?: string;
  readonly description?: RichText | null;
  readonly dueDate?: string | null;
  readonly startDate?: string | null;
  readonly priority?: Priority | null;
}

/** Mirrors web's `asRichText` — narrows the stored `unknown` description so it can be written straight back unmodified when the patch does not touch it. */
export function asRichText(value: unknown): RichText | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as { type?: unknown }).type === 'string' ? (value as RichText) : null;
}

/** A plain object in, the full `cards.update` write body (minus `cardId`/`version`) out. */
export function mergePatch(
  current: CardDetail,
  patch: CardPatch,
): {
  readonly title: string;
  readonly description: RichText | null;
  readonly dueDate: string | null;
  readonly startDate: string | null;
  readonly priority: Priority | null;
} {
  return {
    title: patch.title ?? current.title,
    description:
      'description' in patch ? (patch.description ?? null) : asRichText(current.description),
    dueDate: 'dueDate' in patch ? (patch.dueDate ?? null) : current.dueDate,
    startDate: 'startDate' in patch ? (patch.startDate ?? null) : current.startDate,
    priority: 'priority' in patch ? (patch.priority ?? null) : current.priority,
  };
}
