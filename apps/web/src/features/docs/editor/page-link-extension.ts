import { Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { cn } from '../../../lib/cn.js';

/**
 * A plugin key distinct from `MentionExtension`'s implicit default
 * (`@tiptap/suggestion`'s own `'suggestion'`, unnamed because
 * `work/detail/rich-text-editor.tsx`'s `SuggestionPluginKey.getState(...)`
 * check depends on mention keeping it — changing that would be a Work-side
 * regression to fix a Docs-side collision). Docs' editor is the one place
 * BOTH suggestion-based extensions are active together, and ProseMirror
 * refuses two plugins that resolve to the same key string
 * ("Adding different instances of a keyed plugin (suggestion$)") — caught
 * by `docs-editor.test.tsx` the moment this extension was wired in
 * alongside `@mention`.
 */
const pageLinkSuggestionPluginKey = new PluginKey('pageLinkSuggestion');

/**
 * `[[Page]]` — an atomic, inline reference to another Docs page
 * (ai/phase-6-docs.md §3.10). Structurally the `mention` node's twin, built
 * the same from-scratch way over `@tiptap/suggestion` and for the same
 * reason: `work/richtext.ts`'s `NODE_ATTRIBUTES.pageLink` is `{ pageId,
 * label }`, not the attribute names any off-the-shelf mention/link package
 * assumes, and its own header is explicit that this is a NODE with a
 * validated `pageId`, never a `link` mark's `href` (`SafeUrl` already
 * rejects relative URLs outright).
 *
 * `label` is stored at insertion time, not re-derived from the target
 * page's current title — the identical "content, not a live lookup" choice
 * `mention`'s own comment makes for a person's display name, so a rename
 * elsewhere does not silently reword every reference to it.
 *
 * ## Why this exists as a NEW file rather than living in
 * `lib/tiptap/mention-extension.ts`
 *
 * `mention` sits in `lib/tiptap/` because BOTH Work's editor and Docs' both
 * need it. A page-to-page reference only has one caller so far — Docs —
 * so this stays local until (per PLAN.md §16's own stated bias) a second
 * one actually shows up.
 *
 * ## What this does NOT do
 *
 * No click-to-navigate. `apps/api/src/docs/backlinks.ts` is the reader
 * that makes a `pageLink` node useful (it is what "what links here" scans
 * for) — that is the actual gap this file closes: `[[` never had an editor
 * control to PRODUCE one, so `docs.backlinks` had nothing to ever find. A
 * clickable navigation affordance on top of it is a real, separate
 * addition (it needs a `NodeView` with its own click handling, distinct
 * from placing the cursor) and is left for later rather than bundled in
 * here unasked.
 */

export interface PageLinkCandidate {
  readonly pageId: string;
  readonly label: string;
}

export interface PageLinkOptions {
  readonly suggestion: Omit<SuggestionOptions<PageLinkCandidate, PageLinkCandidate>, 'editor'>;
}

export const PageLinkExtension = Node.create<PageLinkOptions>({
  name: 'pageLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      suggestion: {
        pluginKey: pageLinkSuggestionPluginKey,
        char: '[[',
        // Page titles routinely contain spaces ("Getting Started"); `mention`
        // sets this `false` because an email/name is one token, which does not
        // apply here.
        allowSpaces: true,
        items: () => [],
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'pageLink', attrs: { pageId: props.pageId, label: props.label } },
              // Trailing space so typing continues past the link rather than
              // immediately re-triggering the suggestion — same reasoning as
              // `mention`'s identical trailing space.
              { type: 'text', text: ' ' },
            ])
            .run();
        },
      },
    };
  },

  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-page-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          const pageId = attributes['pageId'];
          return typeof pageId === 'string' ? { 'data-page-id': pageId } : {};
        },
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label') ?? element.textContent,
        renderHTML: (attributes: Record<string, unknown>) => {
          const label = attributes['label'];
          return typeof label === 'string' ? { 'data-label': label } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-page-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
    return [
      'span',
      mergeAttributes(
        // A distinct hue from `mention`'s `accent` chip, so the two reference
        // kinds are visually told apart at a glance — this app's palette has
        // no dedicated "info" token (`styles.css`), so `success` (otherwise
        // unused for inline chips) stands in.
        { 'data-page-link': '', class: 'rounded bg-success/15 px-0.5 text-success' },
        HTMLAttributes,
      ),
      `[[${label}]]`,
    ];
  },

  renderText({ node }) {
    const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
    return `[[${label}]]`;
  },

  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});

/**
 * The visible popup. Deliberately near-identical to
 * `createMentionSuggestion` in `lib/tiptap/mention-extension.ts` — see that
 * function's own comment for why this is a plain DOM list rather than a
 * React tree (`@tiptap/suggestion`'s render lifecycle is framework-agnostic,
 * and mounting a whole React root for eight buttons would be the heavier
 * option for no benefit).
 */
export function createPageLinkSuggestion(
  getCandidates: () => readonly PageLinkCandidate[],
): PageLinkOptions['suggestion'] {
  return {
    // `.configure({ suggestion })` REPLACES `addOptions()`'s default object
    // rather than merging into it, so the distinct key has to be repeated
    // here — this is the object actually used at runtime.
    pluginKey: pageLinkSuggestionPluginKey,
    char: '[[',
    allowSpaces: true,

    items: ({ query }) => {
      const needle = query.trim().toLowerCase();
      const candidates = getCandidates();
      const matches =
        needle === ''
          ? candidates
          : candidates.filter((c) => c.label.toLowerCase().includes(needle));
      return matches.slice(0, 8);
    },

    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'pageLink', attrs: { pageId: props.pageId, label: props.label } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let root: HTMLDivElement | null = null;
      let list: HTMLUListElement | null = null;
      let unmount: (() => void) | null = null;
      let items: PageLinkCandidate[] = [];
      let selected = 0;
      let pick: ((candidate: PageLinkCandidate) => void) | null = null;

      const renderItems = () => {
        if (!list) return;
        list.replaceChildren();

        if (items.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'px-1.5 py-1 text-xs text-ink-faint';
          empty.textContent = 'No matching pages.';
          list.appendChild(empty);
          return;
        }

        items.forEach((item, index) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = item.label;
          button.className = cn(
            'block w-full truncate rounded px-1.5 py-1 text-left text-xs',
            index === selected
              ? 'bg-accent text-accent-ink'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
          );
          // `mousedown` + `preventDefault`, not `click` — see
          // `mention-extension.ts`'s identical comment: a `click` fires after
          // the browser has already moved focus off the editor, which can
          // invalidate the suggestion's `range` before `pick` runs.
          button.addEventListener('mousedown', (event) => {
            event.preventDefault();
            pick?.(item);
          });
          li.appendChild(button);
          list?.appendChild(li);
        });
      };

      return {
        onStart: (props) => {
          items = props.items;
          selected = 0;
          pick = props.command;

          root = document.createElement('div');
          root.className = 'w-56 rounded border border-line bg-surface-raised p-1 shadow-xl';
          list = document.createElement('ul');
          list.className = 'max-h-48 space-y-0.5 overflow-y-auto';
          root.appendChild(list);
          renderItems();

          unmount = props.mount(root);
        },

        onUpdate: (props) => {
          items = props.items;
          selected = Math.min(selected, Math.max(items.length - 1, 0));
          pick = props.command;
          renderItems();
        },

        onKeyDown: ({ view, event, range }) => {
          if (event.key === 'ArrowDown') {
            if (items.length > 0) selected = (selected + 1) % items.length;
            renderItems();
            return true;
          }
          if (event.key === 'ArrowUp') {
            if (items.length > 0) selected = (selected - 1 + items.length) % items.length;
            renderItems();
            return true;
          }
          if (event.key === 'Enter') {
            const item = items[selected];
            if (item) pick?.(item);
            return true;
          }
          if (event.key === 'Escape') {
            view.dispatch(view.state.tr.delete(range.from, range.to));
            return true;
          }
          return false;
        },

        onExit: () => {
          unmount?.();
          root = null;
          list = null;
        },
      };
    },
  };
}
