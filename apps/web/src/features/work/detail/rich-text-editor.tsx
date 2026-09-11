import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { SuggestionPluginKey } from '@tiptap/suggestion';
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

  /* Read directly off the live editor rather than tracked in separate
     state — the same thing `Toolbar`'s `editor.isActive(...)` checks below
     already do, and for the identical reason: `useEditor` re-renders this
     component on every transaction, so there is nothing an extra `useState`
     plus an `onUpdate`/effect pair would buy here that isn't already true of
     the editor instance itself on the very next render. Also the more
     faithful definition for what a PLACEHOLDER should track — this is
     exactly the check `@tiptap/extension-placeholder` itself uses — where
     `isEmptyDocument`'s own special case (a message that is only a mention
     still counts as "has content") is the right call for whether to WARN
     about discarding a draft, not for whether to show hint text. */
  const empty = editor.isEmpty;

  if (bare) {
    return (
      <div className="relative">
        <EditorContent editor={editor} />
        <PlaceholderOverlay text={placeholder} show={empty} bare />
      </div>
    );
  }

  return (
    <div className="rounded border border-line bg-surface-sunken">
      {editable && <Toolbar editor={editor} />}
      <div className="relative">
        <EditorContent editor={editor} />
        <PlaceholderOverlay text={placeholder} show={empty} />
      </div>
      {footer !== undefined && (
        <div className="flex gap-2 border-t border-line px-3 py-2">{footer}</div>
      )}
    </div>
  );
}

/**
 * `styles.css`'s `.rich-text .is-editor-empty:first-child::before` rule (the
 * `content: attr(data-placeholder)` trick) has never actually fired in this
 * component: that selector needs TipTap's official `Placeholder` extension,
 * which adds `is-editor-empty` via a ProseMirror decoration — nothing here
 * ever installed it, so every empty description, comment, chat message and
 * Docs comment composer has been rendering as a blank box with no hint text
 * at all. `assistant-composer.tsx` hit the identical gap building a second,
 * unrelated composer and solved it the same way its own header explains:
 * the live `editor.isEmpty` flag read above, plus an absolutely positioned
 * overlay, rather than a new dependency for one small affordance.
 * `pointer-events-none` so the overlay is never what a click actually lands
 * on — the real, empty contentEditable node sits right underneath it.
 */
function PlaceholderOverlay({
  text,
  show,
  bare = false,
}: {
  readonly text: string;
  readonly show: boolean;
  readonly bare?: boolean;
}) {
  if (!show || text === '') return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute text-sm text-ink-faint',
        bare ? 'top-2 left-0' : 'top-2 left-3',
      )}
    >
      {text}
    </span>
  );
}

function Toolbar({ editor }: { readonly editor: Editor }) {
  const item = (label: string, active: boolean, run: () => void, title: string) => (
    <Button
      key={label}
      size="sm"
      variant="ghost"
      title={title}
      aria-pressed={active}
      className={cn('h-6 px-1.5', active && 'bg-surface-hover text-ink')}
      onClick={run}
    >
      {label}
    </Button>
  );

  return (
    <div className="flex flex-wrap gap-0.5 border-b border-line/50 px-1.5 py-1">
      {item('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {item(
        'I',
        editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        'Italic',
      )}
      {item(
        'S',
        editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(),
        'Strikethrough',
      )}
      {item(
        '</>',
        editor.isActive('code'),
        () => editor.chain().focus().toggleCode().run(),
        'Inline code',
      )}
      {item(
        'H2',
        editor.isActive('heading', { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        'Heading',
      )}
      {item(
        '•',
        editor.isActive('bulletList'),
        () => editor.chain().focus().toggleBulletList().run(),
        'Bullet list',
      )}
      {item(
        '1.',
        editor.isActive('orderedList'),
        () => editor.chain().focus().toggleOrderedList().run(),
        'Numbered list',
      )}
      {item(
        '❝',
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
  placeholder = '',
}: {
  readonly value: unknown;
  /** See `RichTextEditorProps.bare`. */
  readonly bare?: boolean;
  /**
   * Shown in place of an empty document. Defaults to nothing rather than
   * inheriting `RichTextEditor`'s own "Write something…" default — this
   * component renders in many places that already have nothing to show for
   * an empty value on purpose (a sent chat message, a published Docs page),
   * and those must not start showing composer text merely because this file
   * learned how to render a placeholder at all. Pass one explicitly (e.g.
   * "No description.") only where an empty value is a real, expected state
   * worth naming.
   */
  readonly placeholder?: string;
}) {
  return (
    <RichTextEditor
      value={value}
      editable={false}
      bare={bare}
      placeholder={placeholder}
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
