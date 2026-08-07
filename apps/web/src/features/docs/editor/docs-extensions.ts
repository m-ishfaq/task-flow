import Link from '@tiptap/extension-link';
import { OrderedList } from '@tiptap/extension-list';

/**
 * Extension overrides that keep the collaborative editor's Yjs document
 * within `apps/collab/src/content-guard.ts`'s whitelist at the SOURCE,
 * rather than by normalizing it on the way out.
 *
 * Work's non-collaborative editor (`work/detail/rich-text.ts`) has a single
 * point where a whole document is submitted, so `toDocument()` can strip
 * attributes TipTap adds beyond the server's schema right before that one
 * submission. The collaborative editor has no equivalent moment — content
 * flows continuously into the Yjs doc via the sync plugin, and the ONLY
 * place that ever inspects it against the whitelist is
 * `apps/collab`'s save-boundary `enforceContentWhitelist` pass, which does
 * not strip surgically: an invalid mark is replaced WHOLESALE with an
 * unformatted text run (`content-guard.ts`'s own header), and invalid node
 * attributes are cleared entirely.
 *
 * Both standard extensions below carry attributes beyond what
 * `@taskflow/api/richtext`'s `NODE_ATTRIBUTES`/`MarkSchema` allow, confirmed
 * against the installed `@tiptap/extension-link` and `@tiptap/extension-list`
 * source (`addAttributes()`), and against `work/detail/rich-text.ts`'s own
 * `NODE_ATTRIBUTES`/`MARK_ATTRIBUTES` maps, which record exactly the same
 * two exceptions:
 *
 *   link (mark)   default-emits `rel`, `class`, `title` — the server's
 *                 `MarkSchema` for `link` allows only `href` and `target`.
 *                 `rel` is excluded from the schema ON PURPOSE (a document
 *                 that could set it could opt itself out of noopener), so
 *                 this is not a value to pass through — the attribute must
 *                 never be created. Left uncorrected, EVERY link typed in
 *                 this editor would have its formatting silently erased —
 *                 turned back into plain text — the next time
 *                 `onStoreDocument` compacts the page.
 *
 *   orderedList (node)   default-emits `type` alongside `start` — the
 *                        server's `NODE_ATTRIBUTES.orderedList` allows only
 *                        `start`. Milder than the link case (content-guard
 *                        clears the node's attributes rather than deleting
 *                        it), but still a silent reset of a custom start
 *                        number on the next compaction pass.
 *
 * Every other default extension used here (paragraph, text, heading,
 * codeBlock, blockquote, bulletList, listItem, hardBreak, horizontalRule,
 * taskList, taskItem) was checked against the same two maps and emits
 * nothing beyond what the server accepts.
 */

export const DocsLink = Link.extend({
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('href'),
      },
      target: {
        // Matches the base extension's own computed default (`options.
        // HTMLAttributes.target`, `'_blank'` unless overridden below) —
        // links open in a new tab, same as Work's editor.
        default: '_blank',
      },
    };
  },
});

export const DocsOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) =>
          element.hasAttribute('start') ? parseInt(element.getAttribute('start') ?? '', 10) : 1,
      },
    };
  },
});
