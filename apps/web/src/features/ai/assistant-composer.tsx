import { forwardRef, useImperativeHandle, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { PluginKey } from '@tiptap/pm/state';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { useSession } from '../../lib/session.js';
import { useMembers } from '../org/use-members.js';
import { boardsQuery, listsQuery, projectsQuery, sprintsQuery } from '../work/api.js';
import {
  createEntityMentionExtension,
  firstMentionInDoc,
  isAnyMentionSuggestionActive,
  type EntityCandidate,
} from './entity-mention-extension.js';

/**
 * The assistant's message input — a TipTap editor, not a plain
 * `<textarea>`, specifically to carry `@`/`#`/`&`/`%`/`~` mention pickers
 * for people/projects/boards/sprints/lists. Built from a direct request:
 * "zero error" in what gets sent, which a picker that only inserts a
 * display string cannot promise on its own (the model would still have to
 * resolve it via a lookup tool, the exact step that can still go wrong) —
 * see `entity-reference.ts`'s own header for the embedded-id mechanism that
 * closes that gap.
 *
 * ## Why TipTap, when the wire format is a plain string
 *
 * A first instinct is a lighter-weight approach: watch a plain
 * `<textarea>` for a trigger character and splice text in and out by
 * string index. That breaks the moment a person edits text before or
 * after an inserted mention — the recorded index drifts, and there is no
 * way to tell "the user deleted three characters before the mention" from
 * "the user deleted part of the mention itself." TipTap's atomic inline
 * node (`entity-mention-extension.ts`) does not have this problem: a
 * mention is a single indivisible unit that travels with its `refId`
 * regardless of what is typed around it, the same guarantee Chat's own
 * `@mention` already relies on for its rich-text messages. The trade is
 * genuine complexity (a real editor instance instead of a string), spent
 * on correctness a string-splicing approach cannot actually deliver.
 *
 * ## Board/sprint/list pickers need a project (or board) already mentioned
 *
 * `work/api.ts` has no org-wide "every board" or "every sprint" query —
 * `boardsQuery`/`sprintsQuery` take a `projectId`, `listsQuery` a
 * `boardId`, matching the real hierarchy (a board belongs to a project, a
 * list to a board). Rather than invent new backend routes purely for this
 * picker's convenience, `firstMentionInDoc` reads whichever project (or
 * board) the person already mentioned earlier in the SAME draft and scopes
 * the query to it. Typing `&`/`%` before mentioning a project, or `~`
 * before a board, shows a hint instead of a candidate list — a real,
 * documented boundary, not a silent dead end.
 */

export interface AssistantComposerHandle {
  readonly getText: () => string;
  readonly clear: () => void;
  readonly insertPlainText: (text: string) => void;
  readonly focus: () => void;
}

interface AssistantComposerProps {
  readonly disabled: boolean;
  readonly onSubmit: () => void;
  readonly onEmptyChange: (empty: boolean) => void;
  readonly placeholder?: string;
}

function matches(candidate: EntityCandidate, query: string): boolean {
  return query.trim() === '' || candidate.label.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * A real `@tiptap/extension-placeholder` install would do this with a
 * ProseMirror decoration; adding a new dependency for one small affordance
 * in an already-large change is not worth it here. This is the same
 * observable behavior built from state this component tracks anyway
 * (`isEmpty`, via `onUpdate`) — an absolutely positioned overlay shown only
 * while the editor has nothing in it, rather than a CSS `content:
 * attr(data-placeholder)` trick, which needs the attribute on the exact
 * empty `<p>` ProseMirror renders — not the outer `contentEditable` div
 * `editorProps.attributes` actually sets it on — to work at all.
 */
function PlaceholderOverlay({ text, show }: { readonly text: string; readonly show: boolean }) {
  if (!show || text === '') return null;
  return (
    <span className="pointer-events-none absolute top-2 left-3 text-sm text-ink-faint">{text}</span>
  );
}

export const AssistantComposer = forwardRef<AssistantComposerHandle, AssistantComposerProps>(
  function AssistantComposer({ disabled, onSubmit, onEmptyChange, placeholder }, ref) {
    const orgId = useSession((state) => state.orgId) ?? '';
    const queryClient = useQueryClient();
    const { people } = useMembers();
    const [empty, setEmpty] = useState(true);

    // Stable across renders (created once) — every plugin key must stay the
    // SAME reference for `isAnyMentionSuggestionActive`'s lookups against
    // the live editor state to keep working from one render to the next.
    const [pluginKeys] = useState(() => ({
      user: new PluginKey('assistantMention:user'),
      project: new PluginKey('assistantMention:project'),
      board: new PluginKey('assistantMention:board'),
      sprint: new PluginKey('assistantMention:sprint'),
      list: new PluginKey('assistantMention:list'),
    }));

    const userCandidates: readonly EntityCandidate[] = people.map((member) => ({
      id: member.userId,
      label: member.displayName ?? member.email,
    }));

    const editor = useEditor({
      editable: !disabled,
      extensions: [
        StarterKit.configure({
          // No headings, lists, code blocks, or links — a chat message is a
          // few lines of plain text plus mentions, never a rich document.
          heading: false,
          bulletList: false,
          orderedList: false,
          codeBlock: false,
          blockquote: false,
          horizontalRule: false,
          link: false,
        }),
        createEntityMentionExtension({
          name: 'userMention',
          char: '@',
          type: 'user',
          pluginKey: pluginKeys.user,
          emptyHint: 'No matches.',
          fetchItems: (query) =>
            Promise.resolve(userCandidates.filter((candidate) => matches(candidate, query))),
        }),
        createEntityMentionExtension({
          name: 'projectMention',
          char: '#',
          type: 'project',
          pluginKey: pluginKeys.project,
          emptyHint: 'No matches.',
          fetchItems: async (query) => {
            const projects = await queryClient.fetchQuery(projectsQuery(orgId));
            return projects
              .map((project) => ({ id: project.projectId, label: project.name }))
              .filter((candidate) => matches(candidate, query));
          },
        }),
        createEntityMentionExtension({
          name: 'boardMention',
          char: '&',
          type: 'board',
          pluginKey: pluginKeys.board,
          emptyHint: 'Mention a project first.',
          fetchItems: async (query, docEditor) => {
            const project = firstMentionInDoc(docEditor, 'projectMention');
            if (project === null) return [];
            const boards = await queryClient.fetchQuery(
              boardsQuery(orgId, project.id as ProjectId),
            );
            return boards
              .map((board) => ({ id: board.boardId, label: board.name }))
              .filter((candidate) => matches(candidate, query));
          },
        }),
        createEntityMentionExtension({
          name: 'sprintMention',
          char: '%',
          type: 'sprint',
          pluginKey: pluginKeys.sprint,
          emptyHint: 'Mention a project first.',
          fetchItems: async (query, docEditor) => {
            const project = firstMentionInDoc(docEditor, 'projectMention');
            if (project === null) return [];
            const sprints = await queryClient.fetchQuery(
              sprintsQuery(orgId, project.id as ProjectId),
            );
            return sprints
              .map((sprint) => ({ id: sprint.sprintId, label: sprint.name }))
              .filter((candidate) => matches(candidate, query));
          },
        }),
        createEntityMentionExtension({
          name: 'listMention',
          char: '~',
          type: 'list',
          pluginKey: pluginKeys.list,
          emptyHint: 'Mention a board first.',
          fetchItems: async (query, docEditor) => {
            const board = firstMentionInDoc(docEditor, 'boardMention');
            if (board === null) return [];
            const lists = await queryClient.fetchQuery(listsQuery(orgId, board.id as BoardId));
            return lists
              .map((list) => ({ id: list.listId, label: list.name }))
              .filter((candidate) => matches(candidate, query));
          },
        }),
      ],
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      onUpdate: ({ editor: current }) => {
        setEmpty(current.isEmpty);
        onEmptyChange(current.isEmpty);
      },
      editorProps: {
        attributes: {
          class: cn(
            'min-h-[2.5rem] max-h-40 overflow-y-auto rounded-lg border border-line/50 bg-surface-sunken',
            'px-3 py-2 text-sm text-ink transition-all',
            'focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 focus:outline-none',
          ),
        },
        handleKeyDown: (view, event) => {
          if (event.key !== 'Enter' || event.shiftKey) return false;

          // The identical check `rich-text-editor.tsx`'s own
          // `handleKeyDown` makes for Chat/Docs' one mention picker,
          // extended across all five of this composer's own plugin keys —
          // without it, Enter would submit the message instead of picking
          // the highlighted candidate while any popup is open.
          if (isAnyMentionSuggestionActive(view.state, Object.values(pluginKeys))) return false;

          event.preventDefault();
          onSubmit();
          return true;
        },
      },
    });

    useImperativeHandle(
      ref,
      (): AssistantComposerHandle => ({
        getText: () => editor.getText(),
        // `setContent`'s own `emitUpdate` default is not something to rely
        // on across versions — `empty` is updated explicitly here rather
        // than assumed to follow from `onUpdate` firing on its own.
        clear: () => {
          editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
          setEmpty(true);
          onEmptyChange(true);
        },
        insertPlainText: (text) => {
          editor
            .chain()
            .focus()
            .setContent({
              type: 'doc',
              content: [
                { type: 'paragraph', content: text === '' ? [] : [{ type: 'text', text }] },
              ],
            })
            .run();
          const isEmpty = text.trim() === '';
          setEmpty(isEmpty);
          onEmptyChange(isEmpty);
        },
        focus: () => {
          editor.commands.focus();
        },
      }),
      [editor, onEmptyChange],
    );

    return (
      <div className="relative">
        <EditorContent editor={editor} />
        <PlaceholderOverlay text={placeholder ?? ''} show={empty} />
      </div>
    );
  },
);
