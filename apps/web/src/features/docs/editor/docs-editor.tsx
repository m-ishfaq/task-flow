import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { OrgId, PageId, SpaceId } from '@taskflow/contracts';
import { useSession } from '../../../lib/session.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../../components/primitives.js';
import { useMembers } from '../../org/use-members.js';
import {
  createMentionSuggestion,
  MentionExtension,
  type MentionCandidate,
} from '../../../lib/tiptap/mention-extension.js';
import { SAFE_SCHEMES } from '../../work/detail/rich-text.js';
import { pagesQuery } from '../api.js';
import { useCollabProvider, type CollabStatus } from './use-collab-provider.js';
import { DocsLink, DocsOrderedList } from './docs-extensions.js';
import {
  createPageLinkSuggestion,
  PageLinkExtension,
  type PageLinkCandidate,
} from './page-link-extension.js';

/**
 * The live collaborative editor (ai/phase-6-docs.md §3.2, Wave 2 of the UI).
 *
 * ## Two components, not one
 *
 * `useEditor` cannot be called conditionally, and the collab provider is
 * `null` for the one render before its effect runs (see
 * `use-collab-provider.ts`'s own header on why the provider is constructed
 * as an effect, never during render). So `DocsEditor` renders a connecting
 * state for that render, and `DocsEditorReady` — which is where every hook
 * that needs a provider lives — only ever mounts with one.
 *
 * ## What this component is NOT
 *
 * Nothing here re-derives authorization (CLAUDE.md §8.2). `editable` is
 * always `true`; a user who may only read a page still gets an editable-
 * looking editor, and the server enforces the boundary at the protocol
 * level — `apps/collab/src/gateway.ts`'s `beforeHandleMessage` silently
 * drops writes from a read-only connection. That is the same shape every
 * other authorization-sensitive surface in this app already uses: the UI
 * shows the control, the server answers.
 *
 * ## Why the extensions are configured exactly this way
 *
 * The Yjs document flows through `apps/collab/src/compaction.ts`, whose
 * `enforceContentWhitelist` strips anything `apps/api/src/work/richtext.ts`
 * does not admit — so the extensions here are chosen to never EMIT that in
 * the first place. See `docs-extensions.ts`'s header for the two default
 * TipTap extensions that would be silently stripped (link, orderedList).
 * `StarterKit`'s own undo/redo is disabled because `Collaboration` brings
 * its own Yjs-aware undo (`yUndoPlugin`); two undo stacks fight. The Yjs
 * field is `'content'` because that is the fragment name `compaction.ts`
 * reads.
 */

/** What `onReady` hands the page panel — everything `editor/anchor.ts` needs to build or resolve a comment/suggestion anchor. `null` while disconnected. */
export interface DocsEditorHandle {
  readonly editor: Editor;
  readonly provider: HocuspocusProvider;
}

export function DocsEditor({
  orgId,
  spaceId,
  pageId,
  onReady,
}: {
  orgId: OrgId;
  spaceId: SpaceId;
  pageId: PageId;
  /** Notified with a handle once the editor is live, and with `null` on disconnect/unmount. See `docs-page.tsx`'s `PagePanel` for the one caller. */
  onReady?: (handle: DocsEditorHandle | null) => void;
}) {
  const { provider, status, synced } = useCollabProvider(orgId, pageId);

  if (provider === null) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line/50">
        <p className="text-xs text-ink-faint">Connecting…</p>
      </div>
    );
  }

  return (
    <DocsEditorReady
      orgId={orgId}
      spaceId={spaceId}
      pageId={pageId}
      provider={provider}
      status={status}
      synced={synced}
      onReady={onReady}
    />
  );
}

function DocsEditorReady({
  orgId,
  spaceId,
  pageId,
  provider,
  status,
  synced,
  onReady,
}: {
  readonly orgId: OrgId;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
  readonly provider: HocuspocusProvider;
  readonly status: CollabStatus;
  readonly synced: boolean;
  readonly onReady?: ((handle: DocsEditorHandle | null) => void) | undefined;
}) {
  const { people, personOf } = useMembers();
  const userId = useSession((state) => state.userId);
  const email = useSession((state) => state.email);
  const pages = useQuery(pagesQuery(orgId, spaceId));

  /* `@mention` needs the org's member list, the same shape
     `rich-text-editor.tsx` builds. Rebuilt fresh every render — the editor
     re-syncs extension options each render rather than freezing them at
     mount, so the suggestion's `items()` closure sees current members. */
  const candidates: readonly MentionCandidate[] = people.map((member) => ({
    userId: member.userId,
    label: member.email,
  }));

  /* `[[` needs this page's siblings-in-space, the same shape the tree panel
     already loads (`docs-page.tsx`'s `pagesQuery`) — reused here rather than
     a second query. Archived pages and the page being edited are both
     excluded: an archived page is not a link worth creating, and a page
     cannot usefully link to itself. */
  const pageLinkCandidates: readonly PageLinkCandidate[] = (pages.data ?? [])
    .filter((page) => page.archivedAt === null && page.pageId !== pageId)
    .map((page) => ({ pageId: page.pageId, label: page.title }));

  /* The caret the other participants see. `personOf` resolves a display
     name when there is one, falling back to the email — the same lookup
     every other "who is this" surface in the app uses. */
  const displayName = userId !== null ? personOf(userId).label : (email ?? 'You');
  const color = colorForUser(userId ?? email ?? 'anonymous');

  const editor = useEditor({
    editable: true,
    extensions: [
      StarterKit.configure({
        link: false,
        orderedList: false,
        /* Collaboration's yUndoPlugin is the undo stack here; StarterKit's
           own would fight it (docs-extensions.ts's header). */
        undoRedo: false,
      }),
      DocsOrderedList,
      DocsLink.configure({
        openOnClick: false,
        autolink: true,
        /* Same scheme restriction as Work's editor — a `javascript:` URL
           should not be entered in the first place. The server's `SafeUrl`
           is the real control; this turns a save-time rejection into a link
           that never became one. */
        protocols: [...SAFE_SCHEMES],
        isAllowedUri: (uri, context) => {
          try {
            const parsed = new URL(uri, context.protocols.length > 0 ? 'https://x' : undefined);
            return (SAFE_SCHEMES as readonly string[]).includes(parsed.protocol.replace(':', ''));
          } catch {
            return false;
          }
        },
      }),
      TaskList,
      TaskItem.configure({ nested: false }),
      MentionExtension.configure({
        suggestion: createMentionSuggestion(() => candidates),
      }),
      PageLinkExtension.configure({
        suggestion: createPageLinkSuggestion(() => pageLinkCandidates),
      }),
      Collaboration.configure({
        /* MUST be the same `Y.Doc` the provider syncs, and the field MUST be
           `'content'` — `apps/collab/src/compaction.ts` reads
           `document.getXmlFragment('content')`, not the default field. */
        document: provider.document,
        field: 'content',
      }),
      CollaborationCaret.configure({
        provider,
        user: { name: displayName, color },
      }),
    ],
    editorProps: {
      attributes: {
        class: cn('rich-text focus:outline-none min-h-40 px-3 py-2'),
        'data-placeholder': 'Write something…',
      },
    },
  });

  useEffect(() => {
    return () => {
      editor.destroy();
    };
  }, [editor]);

  /* Handed to the page panel so comments/suggestions can build and resolve
     anchors against the SAME editor + provider this component owns —
     `editor/anchor.ts`'s whole reason for needing both. `onReady` must be
     stable (wrap it in `useCallback` at the call site) or this re-fires on
     every render; the cleanup notifies `null` so the panel does not hold a
     stale handle past unmount or a page switch. */
  useEffect(() => {
    onReady?.({ editor, provider });
    return () => {
      onReady?.(null);
    };
  }, [editor, provider, onReady]);

  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-sunken">
      <div className="flex items-center justify-between gap-2 border-b border-line py-1 pl-1.5 pr-2">
        <Toolbar editor={editor} />
        <div className="flex shrink-0 items-center gap-3">
          <Presence provider={provider} />
          <ConnectionPill status={status} synced={synced} />
        </div>
      </div>
      <EditorContent editor={editor} />
    </div>
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
    <div className="flex flex-wrap items-center gap-0.5">
      {item('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {item(
        'I',
        editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        'Italic',
      )}
      {item(
        'U',
        editor.isActive('underline'),
        () => editor.chain().focus().toggleUnderline().run(),
        'Underline',
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
        'H1',
        editor.isActive('heading', { level: 1 }),
        () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        'Heading 1',
      )}
      {item(
        'H2',
        editor.isActive('heading', { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        'Heading 2',
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
        '☑',
        editor.isActive('taskList'),
        () => editor.chain().focus().toggleTaskList().run(),
        'Task list',
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

/** A deterministic colour per user, stable across sessions and devices. */
function colorForUser(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${String(hue)} 65% 45%)`;
}

/** The connection pill next to the toolbar. */
function ConnectionPill({
  status,
  synced,
}: {
  readonly status: CollabStatus;
  readonly synced: boolean;
}) {
  const dot =
    status === 'connected'
      ? synced
        ? 'bg-success'
        : 'bg-warning'
      : status === 'connecting'
        ? 'bg-warning'
        : 'bg-danger';
  const label =
    status === 'connected'
      ? synced
        ? 'Live'
        : 'Syncing…'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Offline';

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted"
      title={synced ? 'Connected and in sync' : 'Connection state'}
    >
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * "N others viewing" from the shared awareness map.
 *
 * CollaborationCaret publishes `{ name, color }` under each client's
 * awareness state, so everyone connected to the same page is visible here —
 * the same Yjs awareness channel the caret labels ride on. Cheap (an event
 * subscription, no polling), and it is the only presence surface this
 * feature needs for now; the avatars it could become are a styling change.
 */
function Presence({ provider }: { readonly provider: HocuspocusProvider }) {
  const [others, setOthers] = useState(0);

  useEffect(() => {
    const awareness = provider.awareness;
    if (awareness === null) return;

    const update = () => {
      const local = awareness.clientID;
      let count = 0;
      for (const [clientId] of awareness.getStates()) {
        if (clientId !== local) count += 1;
      }
      setOthers(count);
    };

    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
    };
  }, [provider]);

  if (others === 0) return null;

  return (
    <span
      className="text-[11px] text-ink-faint"
      title={`${String(others)} other viewer${others === 1 ? '' : 's'}`}
    >
      {others === 1 ? '1 other viewing' : `${String(others)} others viewing`}
    </span>
  );
}
