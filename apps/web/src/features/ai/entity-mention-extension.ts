import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import { cn } from '../../lib/cn.js';
import { encodeReference, type ReferenceType } from './entity-reference.js';

/**
 * The `@`/`#`/`&`/`%`/`~` mention pickers in the assistant's composer —
 * generalizing `lib/tiptap/mention-extension.ts`'s pattern (a TipTap `Node`
 * built directly on `@tiptap/suggestion`) to five entity types instead of
 * one, and to a different OUTPUT need: Chat's mention node's `renderText`
 * only ever needs to round-trip through Chat's own rich-text JSON, which
 * already carries `userId` structurally; the assistant sends a plain
 * STRING (`ChatMessageWire`'s `content`), so this node's `renderText`
 * embeds the id as text via `encodeReference` — see that file's own header
 * for why. `renderHTML` (what a person sees while composing) stays clean —
 * `@Priya Nakamura`, never the id — the embed exists only in the serialized
 * plain text `getText()` produces on submit.
 *
 * One factory, not five near-identical Node definitions: `type`/`char` are
 * the only real differences between "mention a person" and "mention a
 * project," so `createEntityMentionExtension` takes them as config and is
 * called once per entity type from the composer, where the runtime
 * `fetchItems` closure (needing `queryClient`/`orgId`, and for
 * board/sprint/list, the CURRENT document's already-picked project or
 * board) actually lives.
 */

export interface EntityCandidate {
  readonly id: string;
  readonly label: string;
}

export interface EntityMentionOptions {
  readonly suggestion: Omit<SuggestionOptions<EntityCandidate, EntityCandidate>, 'editor'>;
}

/**
 * Every `Suggestion()` plugin defaults to the SAME shared `SuggestionPluginKey`
 * singleton when not given its own — fine for Chat/Docs, which each register
 * exactly one. This composer registers FIVE, and ProseMirror refuses to build
 * an editor state with two plugins sharing a key at all ("Adding different
 * instances of a keyed plugin"), so each entity type needs its own, created
 * by the CALLER (the composer, where all five are instantiated together) and
 * threaded in here — `firstMentionInDoc`'s doc scan doesn't need this, but
 * `handleKeyDown`'s "is any picker's popup currently open" check does, and
 * can only ask each key by name if it already has all five.
 */
export function createEntityMentionExtension(config: {
  readonly name: string;
  readonly char: string;
  readonly type: ReferenceType;
  readonly pluginKey: PluginKey;
  readonly fetchItems: (query: string, editor: Editor) => Promise<readonly EntityCandidate[]>;
  readonly emptyHint: string;
}) {
  return Node.create<EntityMentionOptions>({
    name: config.name,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addOptions() {
      return {
        suggestion: {
          char: config.char,
          allowSpaces: false,

          items: async ({ query, editor }) => {
            const items = await config.fetchItems(query, editor);
            return items.slice(0, 8);
          },

          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: config.name, attrs: { refId: props.id, label: props.label } },
                // A trailing space, matching `mention-extension.ts`'s own
                // reasoning: typing continues past the mention rather than
                // immediately re-triggering it.
                { type: 'text', text: ' ' },
              ])
              .run();
          },

          render: () => createSuggestionRenderer(config.emptyHint),
        },
      };
    },

    addAttributes() {
      return {
        refId: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('data-ref-id'),
          renderHTML: (attributes: Record<string, unknown>) => {
            const refId = attributes['refId'];
            return typeof refId === 'string' ? { 'data-ref-id': refId } : {};
          },
        },
        label: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute('data-label') ?? element.textContent,
          renderHTML: (attributes: Record<string, unknown>) => {
            const label = attributes['label'];
            return typeof label === 'string' ? { 'data-label': label } : {};
          },
        },
      };
    },

    parseHTML() {
      return [{ tag: `span[data-entity-mention="${config.type}"]` }];
    },

    renderHTML({ node, HTMLAttributes }) {
      const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
      return [
        'span',
        mergeAttributes(
          {
            'data-entity-mention': config.type,
            class: 'rounded bg-accent/15 px-0.5 text-accent',
          },
          HTMLAttributes,
        ),
        `${config.char}${label}`,
      ];
    },

    renderText({ node }) {
      const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
      const refId = typeof node.attrs['refId'] === 'string' ? node.attrs['refId'] : '';
      return encodeReference(`${config.char}${label}`, config.type, refId);
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: config.pluginKey,
          ...this.options.suggestion,
        }),
      ];
    },
  });
}

/**
 * Reads whichever entity was picked FIRST for a given node name anywhere in
 * the current document — how the board/sprint/list pickers find "which
 * project (or board) is this person already talking about" without a
 * dedicated org-wide board/sprint/list route to search instead. There is no
 * such route today (`boardsQuery`/`sprintsQuery`/`listsQuery` all require a
 * parent id), and inventing one purely for this picker's convenience would
 * be new backend surface for a UI affordance — searching the draft itself
 * for an already-picked parent is a real, working answer that needs none.
 */
export function firstMentionInDoc(
  editor: Editor,
  nodeName: string,
): { readonly id: string; readonly label: string } | null {
  let found: { readonly id: string; readonly label: string } | null = null;
  editor.state.doc.descendants((node) => {
    if (found !== null) return false;
    if (node.type.name === nodeName) {
      const refId: unknown = node.attrs['refId'];
      const label: unknown = node.attrs['label'];
      if (typeof refId === 'string' && typeof label === 'string') {
        found = { id: refId, label };
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * Whether ANY of this composer's five pickers currently has its popup open
 * — `rich-text-editor.tsx`'s own `handleKeyDown` checks exactly this for
 * its one `SuggestionPluginKey`, so Enter selects the highlighted candidate
 * instead of submitting the message; five independent keys need the same
 * check made five times, not once.
 */
export function isAnyMentionSuggestionActive(
  state: Parameters<PluginKey['getState']>[0],
  pluginKeys: readonly PluginKey[],
): boolean {
  return pluginKeys.some((key) => {
    const suggestionState = key.getState(state) as { readonly active?: boolean } | undefined;
    return suggestionState?.active === true;
  });
}

/**
 * The visible popup — a plain DOM list, not a React tree, the identical
 * "no framework needed for eight buttons" reasoning
 * `mention-extension.ts`'s own header gives. Parameterized by `emptyHint`
 * rather than a hardcoded "No matches." so the board/sprint/list pickers
 * can say "Mention a project first" instead of implying the org simply has
 * none.
 */
function createSuggestionRenderer(
  emptyHint: string,
): ReturnType<NonNullable<SuggestionOptions<EntityCandidate, EntityCandidate>['render']>> {
  let root: HTMLDivElement | null = null;
  let list: HTMLUListElement | null = null;
  let unmount: (() => void) | null = null;
  let items: readonly EntityCandidate[] = [];
  let selected = 0;
  let pick: ((candidate: EntityCandidate) => void) | null = null;

  const renderItems = () => {
    if (!list) return;
    list.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'px-1.5 py-1 text-xs text-ink-faint';
      empty.textContent = emptyHint;
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
      // `mousedown`, not `click`, with its default prevented — a click
      // fires after focus has already left the editor, which can
      // invalidate the suggestion's range before `pick` runs. The identical
      // reasoning `mention-extension.ts`'s own popup documents.
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick?.(item);
      });
      li.appendChild(button);
      list?.appendChild(li);
    });
  };

  return {
    onStart: (props: SuggestionProps<EntityCandidate, EntityCandidate>) => {
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

    onUpdate: (props: SuggestionProps<EntityCandidate, EntityCandidate>) => {
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
}
