import {
  MAX_DEPTH,
  MAX_NODES,
  MarkSchema,
  NODE_ATTRIBUTES,
  NODE_TYPES,
} from '@taskflow/api/richtext';
import type { NodeType } from '@taskflow/api/richtext';

/**
 * The card description arrives over the wire as `z.unknown()`
 * (`work.cards.get`'s own output schema — `apps/api/src/work/router.ts`)
 * because tRPC does not re-run TipTap's whitelist on read, only on write.
 * This is the client half of §6.4's security control: "rich text is
 * rendered by a closed switch over the node/mark whitelist, never by
 * feeding a string to any HTML/Markdown-to-native library" — and per that
 * section's own wording, the walk needs to tolerate an unrecognized node
 * rather than reject the whole document over it, so a future server build
 * that adds a node type this build has not shipped yet degrades to "that
 * one node is missing," not "the card fails to open."
 *
 * `sanitizeRichText` is the validating first pass — plain data in, plain
 * (and now trustworthy) data out, no React/React Native import anywhere in
 * this file, which is what lets it be exercised by Vitest with no
 * component-rendering harness. `rich-text-view.tsx` is the second pass: a
 * pure switch from `SanitizedNode` to RN elements that does no validation
 * of its own, because everything reaching it has already passed this one.
 *
 * Mirrors `apps/api/src/docs/render.ts` — Docs' own "materialize untrusted
 * content into a whitelisted tree for a read-only audience" pass, built for
 * the public-page and PDF-export surfaces named in that file's header for
 * the identical reason this one exists: an authenticated org member's
 * session is not the risk boundary here, a phone screen a user is looking
 * at directly is, so this does not trust "the server already validated it
 * once before writing" any more than that file trusts
 * `content-guard.ts`'s live-document stripping. Node types and mark types
 * come from `@taskflow/api/richtext` — NOT restated — for the same reason
 * `render.ts` imports them rather than declaring its own copy: two
 * whitelists that could drift is worse than one that both server-side
 * renderers and this client-side one all import.
 *
 * ## Why an invalid node is DROPPED, not attr-stripped
 *
 * `render.ts`'s own header makes this call for the identical read-only
 * case: a `mention` or `pageLink` with a missing required attribute
 * (`userId`/`pageId`, `label`) cannot be stripped down to something
 * meaningful — there is no user around to notice and fix it, unlike
 * `content-guard.ts`'s live-editing case. Dropping the node is simpler and
 * never renders a half-broken reference.
 *
 * ## Why depth and node count are bounded again, here
 *
 * `MAX_DEPTH`/`MAX_NODES` already ran server-side before this document was
 * ever stored — the residual risk is not a live attacker (only `card:read`
 * holders ever reach this data, and it only ever came from a `RichTextDocument`
 * parse), it is a recursive walk of data this file does not itself control
 * meeting a phone's much smaller JS stack than a server process's. The same
 * "measure iteratively before you ever recurse" argument `richtext.ts`'s own
 * `measure()` makes applies here to `sanitizeNode`'s recursion, so the walk
 * carries its own counters and bails rather than trusting the tree is shaped
 * the way it was the day it was written.
 */

export interface SanitizedMark {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

export interface SanitizedNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly text?: string;
  readonly marks?: readonly SanitizedMark[];
  readonly content?: readonly SanitizedNode[];
}

function isKnownNodeType(type: unknown): type is NodeType {
  return typeof type === 'string' && (NODE_TYPES as readonly string[]).includes(type);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeMarks(marks: unknown): readonly SanitizedMark[] {
  if (!Array.isArray(marks)) return [];
  const sanitized: SanitizedMark[] = [];
  for (const candidate of marks) {
    const parsed = MarkSchema.safeParse(candidate);
    if (parsed.success) sanitized.push(parsed.data);
  }
  return sanitized;
}

interface Budget {
  count: number;
}

/** `depth` starts at 1 for the root, matching `richtext.ts`'s own `measure()`. */
function sanitizeNode(raw: unknown, budget: Budget, depth: number): SanitizedNode | null {
  if (depth > MAX_DEPTH || budget.count >= MAX_NODES) return null;
  if (!isPlainObject(raw)) return null;
  if (!isKnownNodeType(raw['type'])) return null;
  budget.count += 1;

  const type = raw['type'];

  if (type === 'text') {
    const text = raw['text'];
    if (typeof text !== 'string') return null;
    const marks = sanitizeMarks(raw['marks']);
    return marks.length > 0 ? { type, text, marks } : { type, text };
  }

  const attrsResult = NODE_ATTRIBUTES[type].safeParse(raw['attrs'] ?? {});
  if (!attrsResult.success) return null;

  const rawContent = raw['content'];
  const content = Array.isArray(rawContent)
    ? rawContent
        .map((child) => sanitizeNode(child, budget, depth + 1))
        .filter((child): child is SanitizedNode => child !== null)
    : [];

  return {
    type,
    ...(Object.keys(attrsResult.data).length > 0 ? { attrs: attrsResult.data } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

/**
 * The one entry point: `card.description` (or any other TipTap-JSON field)
 * in, a tree safe to hand `rich-text-view.tsx` out — or `null` for "nothing
 * to show," which covers both an actually-empty description and a document
 * that failed to sanitize at the root (not an object, or not rooted at
 * `doc` — the same requirement `RichTextDocument` places server-side).
 */
export function sanitizeRichText(input: unknown): SanitizedNode | null {
  if (input === null || input === undefined) return null;
  const root = sanitizeNode(input, { count: 0 }, 1);
  if (root?.type !== 'doc') return null;
  return root;
}
