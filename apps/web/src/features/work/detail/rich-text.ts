/**
 * Normalizing TipTap's output into the document the API accepts.
 *
 * ## Why this is needed at all
 *
 * `apps/api/src/work/richtext.ts` validates rich text against a closed list of
 * node types, mark types, and PER-NODE ATTRIBUTES, and every one of those
 * schemas is `.strict()`. An unrecognized attribute is a rejected document, not
 * an ignored key — deliberately, because "quietly accept what we do not
 * understand" is how a stored document ends up meaning different things to
 * different renderers.
 *
 * TipTap does not produce that shape. `editor.getJSON()` emits every attribute
 * its extensions declare, including their defaults:
 *
 *   orderedList  { start: 1, type: null }   — `type` is not in the server schema
 *   link         { href, target, rel, class } — `rel` and `class` are refused
 *                                               ON PURPOSE: a document that
 *                                               could set them could opt itself
 *                                               out of noopener
 *
 * So the obvious implementation — send `getJSON()` — fails validation on any
 * document containing a numbered list or a link. It would look like the API
 * rejecting valid input, and the tempting fix would be to loosen the server
 * schemas, which is precisely backwards.
 *
 * ## What this does, and what it does not
 *
 * It drops attributes the server does not accept, and nothing else. It is
 * NORMALIZATION, not sanitization: no security decision is made here, unknown
 * node types are left alone for the server to refuse, and hrefs are not
 * inspected. The scheme allowlist is enforced twice on the way in — by the
 * editor's `Link` configuration, so a `javascript:` URL cannot be typed, and by
 * `SafeUrl` on the server, which is the one that counts.
 *
 * The map below MIRRORS the server's `NODE_ATTRIBUTES` and mark union. They must
 * be changed together; `rich-text.test.ts` pins the pairs that actually differ.
 */

/** Attributes each node type may carry, mirroring the server's whitelist. */
const NODE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  doc: [],
  paragraph: [],
  text: [],
  hardBreak: [],
  horizontalRule: [],
  blockquote: [],
  bulletList: [],
  orderedList: ['start'],
  listItem: [],
  heading: ['level'],
  codeBlock: ['language'],
  taskList: [],
  taskItem: ['checked'],
  mention: ['userId', 'label'],
};

/** Attributes each mark type may carry. */
const MARK_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  bold: [],
  italic: [],
  strike: [],
  code: [],
  underline: [],
  link: ['href', 'target'],
};

/** URL schemes a link may use. Mirrors `SAFE_SCHEMES` on the server. */
export const SAFE_SCHEMES = ['http', 'https', 'mailto'] as const;

export interface DocumentNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Record<string, unknown>;
  readonly marks?: readonly DocumentNode[];
  readonly content?: readonly DocumentNode[];
}

/** An empty document, in the shape the server's `doc` node expects. */
export const EMPTY_DOCUMENT: DocumentNode = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

/**
 * Keeps only the attributes in `allowed`, and drops the key entirely when none
 * survive.
 *
 * `attrs: {}` is accepted by the server — the schemas parse `node.attrs ?? {}` —
 * but omitting it keeps stored documents smaller and diffable, which matters
 * once Phase 7 starts versioning pages.
 */
function pick(
  attrs: Record<string, unknown> | undefined,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (attrs === undefined) return undefined;

  const kept: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = attrs[key];
    /* `null` is dropped rather than sent. TipTap uses it for "no value" —
       `codeBlock.language` is null for a plain block — and while the server's
       schema does accept a nullable language, `orderedList.start` is
       `number | undefined` and a null there fails. Dropping is correct for
       both. */
    if (value !== undefined && value !== null) kept[key] = value;
  }

  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * Rewrites a TipTap document into the API's shape.
 *
 * Unknown node and mark types pass through untouched. Stripping them here would
 * hide a version mismatch between this bundle and the deployed API behind a
 * document that silently lost content; letting the server refuse it produces an
 * error someone can act on.
 */
export function toDocument(node: DocumentNode): DocumentNode {
  const allowedAttrs = NODE_ATTRIBUTES[node.type];
  const attrs = allowedAttrs === undefined ? node.attrs : pick(node.attrs, allowedAttrs);

  const marks = node.marks?.map((mark) => {
    const allowed = MARK_ATTRIBUTES[mark.type];
    const markAttrs = allowed === undefined ? mark.attrs : pick(mark.attrs, allowed);
    return markAttrs === undefined ? { type: mark.type } : { type: mark.type, attrs: markAttrs };
  });

  return {
    type: node.type,
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(attrs === undefined ? {} : { attrs }),
    ...(marks === undefined || marks.length === 0 ? {} : { marks }),
    ...(node.content === undefined ? {} : { content: node.content.map(toDocument) }),
  };
}

/**
 * True when a document has no text in it.
 *
 * TipTap never produces a truly empty document — an empty editor is a `doc`
 * containing one empty `paragraph` — so "is there anything here" cannot be
 * answered by looking at `content.length`. Used to stop an empty comment being
 * posted and to decide whether a description is worth saving.
 */
export function isEmptyDocument(node: unknown): boolean {
  return flatten(node).trim() === '';
}

/** The text of a document, for placeholders and empty checks. */
export function flatten(node: unknown): string {
  if (node === null || typeof node !== 'object') return '';

  const candidate = node as Partial<DocumentNode>;
  if (typeof candidate.text === 'string') return candidate.text;
  if (!Array.isArray(candidate.content)) return '';

  return candidate.content.map(flatten).join(' ');
}
