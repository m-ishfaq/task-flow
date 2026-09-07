import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import {
  Bold,
  Code,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../../components/primitives.js';
import { useMembers } from '../../org/use-members.js';
import {
  createMentionSuggestion,
  MentionExtension,
  type MentionCandidate,
} from '../../../lib/tiptap/mention-extension.js';
import { EMPTY_DOCUMENT, SAFE_SCHEMES, toDocument, type DocumentNode } from './rich-text.js';

/**
 * The TipTap editor (PLAN.md §4.1 — "stores JSON, never HTML").
 *
 * ## The two rules this component exists to keep
 *
 * 1. **Nothing here ever touches HTML.** No `getHTML()`, no `setContent` with a
 *    markup string, and no `dangerouslySetInnerHTML` — the last is a lint error
 *    workspace-wide (`jsxHtml` in packages/config/eslint/security.js). The
 *    document goes in as JSON and comes out as JSON, and TipTap renders it by
 *    building DOM nodes from the tree rather than by parsing a string.
 *
 * 2. **Links are restricted to safe schemes at the point of entry.** That is not
 *    the security control — `SafeUrl` on the server is, and it runs on every
 *    document regardless of what typed it. This is so a `javascript:` URL cannot
 *    be entered in the first place, which turns a confusing rejection at save
 *    time into a link that simply does not become a link.
 *
 * Output goes through `toDocument()` because TipTap's JSON carries attributes
 * the server's `.strict()` schemas refuse; see rich-text.ts.
 */

export interface RichTextEditorProps {
  readonly value: unknown;
  readonly onChange: (document: DocumentNode) => void;
  readonly placeholder?: string;
  readonly editable?: boolean;
  readonly className?: string;
  /** Rendered under the editor, e.g. Save / Cancel. */
  readonly footer?: React.ReactNode;
  /**
   * Enter sends; Shift+Enter still inserts a line break. Omitted by every
   * caller that does not pass it, which is what keeps this additive — Work's
   * comment composer submits on an explicit button only, and nothing about
   * that changes unless a caller opts in. Chat's composer is the one that
   * does, because "Enter sends" is the one keyboard behaviour every chat
   * product trains people to expect before they ever look for a button.
   */
  readonly onSubmit?: () => void;
  /**
   * Skips the bordered/background card `RichTextEditor` normally wraps
   * itself in, rendering just the content. Only meaningful with
   * `editable={false}` — `RichTextView`'s job is showing a stored document
   * inline where the surrounding component already provides the container
   * (a chat message line, sitting inside its own hover-highlighted row) —
   * an editable surface still needs the frame that visually marks it as a
   * text box you can click into. Omitted by every existing caller, so
   * Work's comments and card descriptions render exactly as before.
   */
  readonly bare?: boolean;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write something…',
  editable = true,
  className,
  footer,
  onSubmit,
  bare = false,
}: RichTextEditorProps) {
  /* `@mention` needs the org's member list. Rebuilt fresh every render, same
     as `Link`'s `isAllowedUri` below it — this file already relies on
     `useEditor` re-syncing extension options each render rather than freezing
     them at mount, so the suggestion's `items()` closure sees the current
     members with no ref or memoization needed. */
  const { people } = useMembers();
  const candidates: readonly MentionCandidate[] = people.map((member) => ({
    userId: member.userId,
    label: member.email,
  }));

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        /* Task lists are excluded even though the server's whitelist admits
           them: a card already has first-class checklists with their own
           counters, permissions and events, and a second, untracked kind of
           checkbox inside the description would be the one people tick. */
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: [...SAFE_SCHEMES],
        /* `isAllowedUri` is what actually refuses a scheme — `protocols` only
           governs autolinking. Both are set because either alone leaves a path
           in: pasting a `javascript:` URL bypasses the first, and typing one
           bypasses the second. */
        isAllowedUri: (uri, context) => {
          try {
            const parsed = new URL(uri, context.protocols.length > 0 ? 'https://x' : undefined);
            return (SAFE_SCHEMES as readonly string[]).includes(parsed.protocol.replace(':', ''));
          } catch {
            return false;
          }
        },
      }),
      MentionExtension.configure({
        suggestion: createMentionSuggestion(() => candidates),
      }),
    ],
    /* TipTap types its content as MUTABLE `JSONContent`, and every document in
       this app is readonly — the query cache hands out frozen-by-convention
       values and `DocumentNode` says so. The cast is at this one boundary
       because TipTap only reads the tree here; it builds its own document from
       it and never writes back. */
    content: (isDocument(value) ? value : EMPTY_DOCUMENT) as never,
    editorProps: {
      attributes: {
        class: cn(
          /* No `focus:outline-none` here. Tailwind's `focus:` utility lives in
             the `utilities` layer, which beats `styles.css`'s `@layer base`
             `:focus-visible` rule regardless of selector specificity — so this
             editor's contentEditable div had NO visible focus indicator for a
             keyboard user, only the text caret, which is invisible in an empty
             field. Leaving the class off lets the app-wide accent ring apply
             here exactly like every other interactive element; `:focus-visible`
             already excludes mouse-click focus, so this changes nothing about
             how a click into the editor looks. ai/phase-6.5-ui-polish.md Wave 1. */
          'rich-text',
          bare ? undefined : 'min-h-24 px-3 py-2',
          className,
        ),
        'data-placeholder': placeholder,
      },
      handleKeyDown: (view, event) => {
        if (onSubmit === undefined || event.key !== 'Enter' || event.shiftKey) return false;

        /* `editorProps.handleKeyDown` runs BEFORE any extension's own
           ProseMirror plugin gets a chance at the event (`EditorView.someProp`
           checks the view's direct props first) — so without this check, Enter
           would submit the message instead of picking the highlighted
           `@mention` candidate while the suggestion popup is open. Querying the
           suggestion plugin's own state is what tells the two cases apart,
           rather than guessing from the document around the cursor. */
        const suggestionState = SuggestionPluginKey.getState(view.state) as
          { readonly active?: boolean } | undefined;
        if (suggestionState?.active === true) return false;

        event.preventDefault();
        onSubmit();
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(toDocument(instance.getJSON() as DocumentNode));
    },
  });

  /* Re-seeds the editor when the card being edited changes. Without it, opening
     a second card renders the first one's description — the editor holds its own
     document and does not watch `content` after mount. `emitUpdate: false` so
     loading a card is not recorded as an edit the panel would offer to save. */
  useEffect(() => {
    const next = isDocument(value) ? value : EMPTY_DOCUMENT;
    /* Compared before setting. `setContent` resets the selection, so writing it
       unconditionally would move the caret to the start on every keystroke —
       `onUpdate` changes `value`, which re-runs this effect. */
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(next)) return;

    editor.commands.setContent(next as never, { emitUpdate: false });
  }, [editor, value]);

  if (bare) {
    return <EditorContent editor={editor} />;
  }

  return (
    <div className="rounded border border-line bg-surface-sunken">
      {editable && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      {footer !== undefined && (
        <div className="flex gap-2 border-t border-line px-3 py-2">{footer}</div>
      )}
    </div>
  );
}

/**
 * Icon buttons, not the literal glyphs (`B`, `</>`, `❝`…) this toolbar used to
 * render — a text-label toolbar was the one place this app's rich text
 * surfaces (card descriptions, comments, chat) still read as a dev tool
 * rather than a designed editor. `title` still carries the full word, so the
 * icon-only button stays labelled for a screen reader and a mouse hover
 * alike; only the visible glyph changed.
 */
function Toolbar({ editor }: { readonly editor: Editor }) {
  const item = (Icon: LucideIcon, active: boolean, run: () => void, title: string) => (
    <Button
      key={title}
      size="sm"
      variant="ghost"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn('h-6 w-6 px-0', active && 'bg-surface-hover text-ink')}
      onClick={run}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2} />
    </Button>
  );

  return (
    <div className="flex flex-wrap gap-0.5 border-b border-line/50 px-1.5 py-1">
      {item(Bold, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {item(
        Italic,
        editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        'Italic',
      )}
      {item(
        Strikethrough,
        editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(),
        'Strikethrough',
      )}
      {item(
        Code,
        editor.isActive('code'),
        () => editor.chain().focus().toggleCode().run(),
        'Inline code',
      )}
      {item(
        Heading2,
        editor.isActive('heading', { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        'Heading',
      )}
      {item(
        List,
        editor.isActive('bulletList'),
        () => editor.chain().focus().toggleBulletList().run(),
        'Bullet list',
      )}
      {item(
        ListOrdered,
        editor.isActive('orderedList'),
        () => editor.chain().focus().toggleOrderedList().run(),
        'Numbered list',
      )}
      {item(
        Quote,
        editor.isActive('blockquote'),
        () => editor.chain().focus().toggleBlockquote().run(),
        'Quote',
      )}
    </div>
  );
}

/** A read-only rendering of a stored document. */
export function RichTextView({
  value,
  bare = false,
}: {
  readonly value: unknown;
  /** See `RichTextEditorProps.bare`. */
  readonly bare?: boolean;
}) {
  return (
    <RichTextEditor
      value={value}
      editable={false}
      bare={bare}
      onChange={() => {
        /* Read-only: TipTap still calls onUpdate for its own internal
           normalization on mount, and there is nothing to persist. */
      }}
    />
  );
}

function isDocument(value: unknown): value is DocumentNode {
  return (
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc'
  );
}
