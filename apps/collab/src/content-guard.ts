import * as Y from 'yjs';
import { MarkSchema, NODE_ATTRIBUTES, NODE_TYPES, type NodeType } from '@taskflow/api/richtext';

/**
 * The save-boundary content whitelist pass (ai/phase-6-docs.md §3.8, §7.3 —
 * decided: strip silently, from the live `Y.Doc` itself).
 *
 * ## Why this walks `Y.XmlElement`/`Y.XmlText` directly, not `y-prosemirror`
 *
 * `y-prosemirror` is the library that will eventually bind a live TipTap
 * editor to a `Y.Doc` client-side, and its `peerDependencies` pull in
 * `prosemirror-view` — a DOM-dependent package with no reason to load on a
 * server that never renders anything. This module needs none of that: Yjs's
 * OWN `Y.XmlElement` (`nodeName`, `getAttributes()`) and `Y.XmlText`
 * (`toDelta()`) are enough to walk the tree, and they ship in the base `yjs`
 * package this app already depends on.
 *
 * What DOES matter is matching y-prosemirror's wire convention exactly, since
 * that is what will actually produce these documents once the editor exists.
 * Checked against its source (`sync-plugin.js`, `marksToAttributes` /
 * `yattr2markname`) rather than assumed: a mark becomes a `Y.XmlText` delta
 * attribute keyed by `mark.type.name`, value `mark.attrs` — except when two
 * instances of the same overlapping mark type coexist on one run, where the
 * key gets an `--<8-char-hash>` suffix to disambiguate. `MARK_HASH_SUFFIX`
 * strips that suffix before validating, mirroring y-prosemirror's own
 * `yattr2markname` regex byte for byte.
 *
 * ## Node types and marks are validated against Work's OWN whitelist
 *
 * `NODE_ATTRIBUTES`, `NODE_TYPES` and `MarkSchema`, imported from
 * `@taskflow/api/richtext` rather than restated — see that file's own header
 * on why Docs reuses Work's rules instead of maintaining a second copy.
 *
 * ## Node-level vs. mark-level stripping, and why they are not symmetric
 *
 * An unknown node type is deleted outright — there is no partial version of
 * "a node type nobody implemented" worth keeping. A node with a KNOWN type
 * but invalid attributes has every attribute removed rather than deleted
 * entirely, on the same reasoning richtext.ts's own whole-document reject
 * uses at one level up: the attribute set as a whole is not on the
 * whitelist, and guessing which individual keys were "the bad one" invites
 * exactly the kind of partial-fix bug this pass exists to avoid.
 *
 * A text run carrying a disallowed mark is replaced WHOLESALE with an
 * unformatted run of the same characters, rather than surgically clearing
 * just the one bad mark via `YText.format()`'s index/length ranges. This is
 * coarser — the run loses every mark it had, not only the offending one —
 * and deliberately so: `format()`'s range math has to agree exactly with
 * `toDelta()`'s segment boundaries or it silently reformats the wrong
 * characters, and getting that wrong is invisible until a real document hits
 * it (the same failure category this codebase has hit before — rank drift,
 * `neighbours.ts`'s self-drop bug). Deleting and reinserting a whole
 * `Y.XmlText` is two well-documented, independently-obvious operations.
 */

export interface ContentGuardResult {
  readonly strippedNodes: number;
  readonly strippedTextRuns: number;
  readonly changed: boolean;
}

const MARK_HASH_SUFFIX = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

function baseMarkName(attributeKey: string): string {
  return MARK_HASH_SUFFIX.exec(attributeKey)?.[1] ?? attributeKey;
}

function isKnownNodeType(nodeName: string): nodeName is NodeType {
  return (NODE_TYPES as readonly string[]).includes(nodeName);
}

interface DeltaSegment {
  readonly insert: string;
  readonly attributes?: Record<string, unknown>;
}

function deltaOf(text: Y.XmlText): readonly DeltaSegment[] {
  return text.toDelta() as readonly DeltaSegment[];
}

/** The plain characters of a text run, with every mark discarded. */
function plainTextOf(text: Y.XmlText): string {
  return deltaOf(text)
    .map((segment) => segment.insert)
    .join('');
}

/** True when every mark on this text run is on the whitelist. */
function textRunIsValid(text: Y.XmlText): boolean {
  for (const segment of deltaOf(text)) {
    if (!segment.attributes) continue;

    for (const [key, value] of Object.entries(segment.attributes)) {
      const markType = baseMarkName(key);
      // Marks without their own attributes carry `{}` on the Yjs side (never
      // `undefined`), and MarkSchema's `.strict()` members that take no
      // `attrs` field at all would reject an `attrs: {}` key that shouldn't
      // be there — so the candidate shape only includes `attrs` when the
      // mark actually carries any, matching what a real JSON mark (Work's
      // own format) would look like for the same mark type.
      const hasAttrs = value !== null && typeof value === 'object' && Object.keys(value).length > 0;
      const candidate = hasAttrs ? { type: markType, attrs: value } : { type: markType };

      if (!MarkSchema.safeParse(candidate).success) return false;
    }
  }

  return true;
}

/**
 * Strips content outside the whitelist from a live `Y.XmlFragment`, in place,
 * inside a single transaction.
 *
 * Iterates children back-to-front so a deletion never invalidates the index
 * of an element not yet visited.
 */
export function enforceContentWhitelist(fragment: Y.XmlFragment): ContentGuardResult {
  let strippedNodes = 0;
  let strippedTextRuns = 0;

  const walk = (parent: Y.XmlFragment): void => {
    for (let index = parent.length - 1; index >= 0; index--) {
      const child = parent.get(index);

      if (child instanceof Y.XmlElement) {
        if (!isKnownNodeType(child.nodeName)) {
          parent.delete(index, 1);
          strippedNodes += 1;
          continue;
        }

        const schema = NODE_ATTRIBUTES[child.nodeName];
        if (!schema.safeParse(child.getAttributes()).success) {
          for (const key of Object.keys(child.getAttributes())) child.removeAttribute(key);
          strippedNodes += 1;
        }

        walk(child);
        continue;
      }

      if (child instanceof Y.XmlText) {
        if (!textRunIsValid(child)) {
          // NOT `toString()` — confirmed by a failing test before this line
          // existed: `YXmlText.toString()` renders marks as pseudo-XML tags
          // (`<link href="javascript:...">click me</link>`), so using it here
          // would have reinserted the very attribute this pass exists to
          // remove, as visible literal text instead of a live mark. `toDelta()`
          // segments always carry the plain characters in `insert`, with
          // formatting held separately in `attributes` — concatenating just
          // the `insert` values is the actual plain-text extraction.
          const plainText = plainTextOf(child);
          parent.delete(index, 1);
          parent.insert(index, [new Y.XmlText(plainText)]);
          strippedTextRuns += 1;
        }
      }
    }
  };

  const doc = fragment.doc;
  if (doc === null) {
    walk(fragment);
  } else {
    doc.transact(() => {
      walk(fragment);
    }, 'content-guard');
  }

  return {
    strippedNodes,
    strippedTextRuns,
    changed: strippedNodes > 0 || strippedTextRuns > 0,
  };
}
