import { Node, mergeAttributes } from '@tiptap/core';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { cn } from '../cn.js';

/**
 * `@mention` — an atomic, inline reference to a person.
 *
 * Not `@tiptap/extension-mention`. That package exists and would work, but its
 * built-in attribute names (`id`, `label`) do not match the server's
 * `richtext.ts` whitelist (`userId`, `label`) — reaching for `.extend()` to
 * rename them, on top of its own default `command()` wiring, would fight the
 * package more than it saves. This is a small, from-scratch `Node` built
 * directly on `@tiptap/suggestion` — the same lower-level utility the official
 * extension is built on — so the attributes this emits are exactly the ones
 * `NODE_ATTRIBUTES.mention` on the server accepts, with nothing to translate
 * in `toDocument()`.
 *
 * `label` is stored on the node at mention time, not resolved live from
 * `userId` — see the matching comment on the server's `NODE_ATTRIBUTES.mention`
 * for why: it is CONTENT, not a live lookup, and should not silently reword
 * itself if the person renames their account later.
 *
 * Lives under `lib/tiptap/` rather than `features/work/detail/` because Docs'
 * collaborative editor (Phase 6 Wave 2) needs the identical node — one
 * definition two features share, not a second copy free to drift from the
 * server's whitelist.
 */

export interface MentionCandidate {
  readonly userId: string;
  readonly label: string;
}

export interface MentionOptions {
  readonly suggestion: Omit<SuggestionOptions<MentionCandidate, MentionCandidate>, 'editor'>;
}

export const MentionExtension = Node.create<MentionOptions>({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      suggestion: {
        char: '@',
        allowSpaces: false,
        items: () => [],
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mention', attrs: { userId: props.userId, label: props.label } },
              // A trailing space, so typing continues past the mention rather
              // than immediately re-triggering it — the same reason a real
              // word processor's autocomplete leaves the cursor past a space.
              { type: 'text', text: ' ' },
            ])
            .run();
        },
      },
    };
  },

  addAttributes() {
    return {
      userId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-user-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          const userId = attributes['userId'];
          return typeof userId === 'string' ? { 'data-user-id': userId } : {};
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
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
    return [
      'span',
      mergeAttributes(
        { 'data-mention': '', class: 'rounded-md bg-accent/15 px-0.5 text-accent' },
        HTMLAttributes,
      ),
      `@${label}`,
    ];
  },

  renderText({ node }) {
    const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
    return `@${label}`;
  },

  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});

/**
 * The visible popup — a plain DOM list, not a React tree.
 *
 * `@tiptap/suggestion`'s render lifecycle (`onStart`/`onUpdate`/`onExit`) is
 * framework-agnostic and hands back a `mount()` helper that anchors a real
 * DOM element to the cursor via Floating UI, repositioning it on scroll and
 * resize with no listeners of our own to manage. Reaching for a React portal
 * here would mean mounting a whole root just to render eight buttons; this is
 * the same class of "no framework needed" the rest of `list-column.tsx`'s
 * inline edit panel already accepts for a plain absolutely-positioned form.
 *
 * `getCandidates` is called fresh on every keystroke rather than closed over
 * once — the caller passes a function reading through a ref, so this always
 * sees the org's current member list without the extension itself needing to
 * be recreated when that list loads or changes.
 */
export function createMentionSuggestion(
  getCandidates: () => readonly MentionCandidate[],
): MentionOptions['suggestion'] {
  return {
    char: '@',
    allowSpaces: false,

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
          { type: 'mention', attrs: { userId: props.userId, label: props.label } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let root: HTMLDivElement | null = null;
      let list: HTMLUListElement | null = null;
      let unmount: (() => void) | null = null;
      let items: MentionCandidate[] = [];
      let selected = 0;
      let pick: ((candidate: MentionCandidate) => void) | null = null;

      const renderItems = () => {
        if (!list) return;
        list.replaceChildren();

        if (items.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'px-1.5 py-1 text-xs text-ink-faint';
          empty.textContent = 'No matches.';
          list.appendChild(empty);
          return;
        }

        items.forEach((item, index) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = item.label;
          button.className = cn(
            'block w-full truncate rounded-md px-1.5 py-1 text-left text-xs',
            index === selected
              ? 'bg-accent text-accent-ink'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
          );
          /* `mousedown`, not `click` — and `preventDefault` on it. A click
             fires after the browser has already moved focus off the editor,
             which both blurs the contentEditable and can invalidate the
             suggestion's `range` before `pick` runs. Stopping the mousedown's
             default action is what keeps the editor focused and the range
             valid through the selection. */
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
          root.className = 'w-56 rounded-card border border-line bg-surface-raised p-1 shadow-xl';
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
            // No dedicated "close" call in this version of the plugin's public
            // API for an unkeyed instance — deleting the trigger text is what
            // makes the match stop matching, which is what actually closes it.
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
