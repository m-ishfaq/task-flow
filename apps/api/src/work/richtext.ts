import { z } from 'zod';

/**
 * Rich text — TipTap JSON, never HTML (CLAUDE.md rule 4, PLAN.md §8.7).
 *
 * ## Why a whitelist and not a shape check
 *
 * The rule "rich text is TipTap JSON, never HTML" removes the obvious XSS: there
 * is no markup column, so there is nothing for a renderer to trust. It does not
 * by itself remove the second one. TipTap renders a node by looking up its
 * `type` in the editor's extension map, and several standard extensions turn an
 * ATTRIBUTE into a URL or a DOM attribute — `link.href` is the one that matters,
 * because `javascript:` in an href is script execution reached entirely through
 * valid JSON.
 *
 * So this validates against a closed list of node types, mark types, and
 * per-node attributes, and rejects anything else outright. A document arriving
 * with a node type nobody implemented is not sanitized into an empty paragraph —
 * it is refused, because a client sending one is either a version this build
 * cannot render or an attacker probing what the parser accepts, and quietly
 * accepting either produces a stored document whose meaning depends on which
 * renderer opens it.
 *
 * ## The pairing with description_text
 *
 * `flattenToText` produces the `description_text` column. Search never parses
 * this JSON — that is what keeps the Phase 8 index from depending on the
 * document schema, and what makes the GIN index in migration 0008 indexable at
 * all.
 */

/**
 * Node types this build renders.
 *
 * Adding one means adding its attribute schema below. A node with no entry is
 * rejected, which is why the list and the attribute map are one structure
 * rather than two that could disagree.
 */
const NODE_ATTRIBUTES = {
  doc: z.object({}).strict(),
  paragraph: z.object({}).strict(),
  text: z.object({}).strict(),
  hardBreak: z.object({}).strict(),
  horizontalRule: z.object({}).strict(),
  blockquote: z.object({}).strict(),
  bulletList: z.object({}).strict(),
  orderedList: z.object({ start: z.number().int().min(0).optional() }).strict(),
  listItem: z.object({}).strict(),
  heading: z.object({ level: z.number().int().min(1).max(6) }).strict(),
  codeBlock: z.object({ language: z.string().max(40).nullable().optional() }).strict(),
  taskList: z.object({}).strict(),
  taskItem: z.object({ checked: z.boolean() }).strict(),
} as const;

type NodeType = keyof typeof NODE_ATTRIBUTES;

const NODE_TYPES = Object.keys(NODE_ATTRIBUTES) as readonly NodeType[];

/**
 * URL schemes a link may use.
 *
 * The reason this file exists. `javascript:`, `data:` and `vbscript:` all reach
 * script execution through an href that TipTap will happily render, and none of
 * them looks unusual in a JSON payload.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

const SafeUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        // Relative URLs have no scheme to abuse, but they also have no meaning
        // outside a browsing context this document does not have. Rejecting them
        // keeps "what can be in an href" answerable by reading SAFE_SCHEMES.
        return false;
      }
      return (SAFE_SCHEMES as readonly string[]).includes(parsed.protocol);
    },
    `Links must use one of: ${SAFE_SCHEMES.join(', ')}`,
  );

/**
 * Mark types, written out rather than generated from a map.
 *
 * A `discriminatedUnion` built by mapping over an object loses the literal
 * types Zod needs to discriminate on, and recovering them takes a double cast —
 * which would defeat the point of the union being the thing that decides what a
 * mark may carry. Five lines of repetition buys a schema the compiler checks.
 */
const MarkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }).strict(),
  z.object({ type: z.literal('italic') }).strict(),
  z.object({ type: z.literal('strike') }).strict(),
  z.object({ type: z.literal('code') }).strict(),
  z.object({ type: z.literal('underline') }).strict(),
  z
    .object({
      type: z.literal('link'),
      attrs: z
        .object({
          href: SafeUrl,
          /* No `rel` and no `class`: those are the renderer's decision, and a
             document that could set them could opt itself out of noopener. */
          target: z.enum(['_blank', '_self']).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * The shape the flattener and the services work with.
 *
 * `attrs` and `marks` are deliberately loose here. This interface exists so
 * that `flattenToText` can walk a document and so a service can name the
 * parameter type — it is not the validation, which is `RichTextDocument`
 * below. Restating the attribute rules in the type as well would create a
 * second definition free to drift from the schema that actually runs.
 */
export interface RichTextNode {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: unknown;
  readonly marks?: readonly unknown[] | undefined;
  readonly content?: readonly RichTextNode[] | undefined;
}

/**
 * Depth limit.
 *
 * Nesting is unbounded in the format and bounded in every renderer. A document
 * 10,000 lists deep is not a document; it is a stack overflow in whatever walks
 * it — including `flattenToText` below, which recurses.
 */
const MAX_DEPTH = 32;

/**
 * Total node budget, so a wide-but-shallow document cannot do the same job.
 *
 * Enforced AFTER Zod has parsed the whole tree, which means a hostile document
 * is walked twice before it is rejected. That is acceptable only because the
 * Fastify body limit bounds the input first — this budget is about what a
 * legitimate-sized payload can express, not about absorbing an unbounded one.
 * Raising the body limit without revisiting this would make it the only thing
 * standing between a 50 MB request and a parse.
 */
const MAX_NODES = 10_000;

const MAX_TEXT_LENGTH = 100_000;

const BaseNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z
    .object({
      type: z.enum(NODE_TYPES as unknown as [NodeType, ...NodeType[]]),
      text: z.string().max(MAX_TEXT_LENGTH).optional(),
      attrs: z.record(z.unknown()).optional(),
      marks: z.array(MarkSchema).max(16).optional(),
      content: z.array(BaseNodeSchema).optional(),
    })
    .strict()
    .superRefine((node, ctx) => {
      // Attributes are validated per node type here rather than by a
      // discriminated union, because the union would have to be built over 13
      // members whose shapes are mostly identical, and the error it produces
      // names every alternative rather than the one that failed.
      // `node.type` is already narrowed to NodeType by the enum above, so the
      // lookup cannot miss.
      const schema = NODE_ATTRIBUTES[node.type];
      const result = schema.safeParse(node.attrs ?? {});
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid attributes for node "${node.type}": ${result.error.issues
            .map((issue) => issue.message)
            .join('; ')}`,
          path: ['attrs'],
        });
      }

      // Only text nodes carry text, and text nodes carry nothing else. A node
      // with both is ambiguous about what it renders.
      if (node.type === 'text' && typeof node.text !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A text node must have text.',
          path: ['text'],
        });
      }
      if (node.type !== 'text' && node.text !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Only text nodes may carry text, not "${node.type}".`,
          path: ['text'],
        });
      }
    }),
);

/**
 * A whole document.
 *
 * The root must be a `doc`. Accepting a bare paragraph would mean two shapes
 * for one column, and the flattener and the editor would each pick one.
 */
export const RichTextDocument = BaseNodeSchema.superRefine((node, ctx) => {
  if (node.type !== 'doc') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A rich text document must have a root node of type "doc".',
    });
    return;
  }

  const { nodes, depth } = measure(node);
  if (depth > MAX_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Document nesting exceeds ${String(MAX_DEPTH)} levels.`,
    });
  }
  if (nodes > MAX_NODES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Document exceeds ${String(MAX_NODES)} nodes.`,
    });
  }
});

/**
 * Counts nodes and measures depth in one iterative pass.
 *
 * Iterative on purpose: this runs on documents that have not yet been checked
 * for depth, so a recursive version would be the very stack overflow the limit
 * exists to prevent.
 */
function measure(root: RichTextNode): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;

  const stack: { node: RichTextNode; level: number }[] = [{ node: root, level: 1 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    nodes += 1;
    if (current.level > depth) depth = current.level;

    // Bail out early rather than walking a hostile document to completion.
    if (nodes > MAX_NODES || depth > MAX_DEPTH) break;

    for (const child of current.node.content ?? []) {
      stack.push({ node: child, level: current.level + 1 });
    }
  }

  return { nodes, depth };
}

/**
 * The plain text of a document — the `description_text` column.
 *
 * Block-level nodes contribute a newline so that two paragraphs do not run
 * their last and first words together, which would make the search index match
 * a word nobody wrote.
 *
 * Safe to recurse: every caller passes a document that `RichTextDocument`
 * already accepted, so depth is bounded by MAX_DEPTH.
 */
export function flattenToText(node: RichTextNode): string {
  const parts: string[] = [];

  const walk = (current: RichTextNode): void => {
    if (typeof current.text === 'string') parts.push(current.text);
    for (const child of current.content ?? []) walk(child);
    if (BLOCK_NODES.has(current.type)) parts.push('\n');
  };

  walk(node);

  return parts
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

const BLOCK_NODES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'horizontalRule',
]);
