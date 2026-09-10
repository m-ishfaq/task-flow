import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentId, PageId, SuggestionId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import { useSession } from '../../lib/session.js';
import { formatRelative } from '../../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Skeleton,
} from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import { RichTextEditor, RichTextView } from '../work/detail/rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import { buildAnchor, buildSelectionAnchor, resolveAnchor } from './editor/anchor.js';
import type { DocsEditorHandle } from './editor/docs-editor.js';
import {
  createComment,
  createSuggestion,
  decideSuggestion,
  deleteComment,
  invalidatePageComments,
  invalidatePageSuggestions,
  pageCommentsQuery,
  pageSuggestionsQuery,
  resolveComment,
  updateComment,
  type SuggestionSummary,
} from './api.js';

/**
 * Comments and suggestions (ai/phase-6-docs.md §3.6, Wave 3).
 *
 * ## Where anchors come from
 *
 * Both threads anchor into the live document via a Yjs `RelativePosition`
 * (§3.6 — never a byte offset), built and resolved entirely in the browser
 * against the SAME editor + provider `docs-editor.tsx` owns
 * (`editor/anchor.ts`'s own header on why). `editorHandle` is `null`
 * whenever the live editor is not connected (still loading, or the page has
 * no body content session open) — every control that needs to build an
 * anchor is disabled in that state rather than sending a request that could
 * only fail.
 *
 * ## What "Reveal" does, and what it does not
 *
 * Resolving an anchor gives a POSITION in the current document; this panel
 * moves the editor's selection there and asks it to scroll into view. It
 * does not highlight the original range as a persistent decoration — that
 * would need a custom ProseMirror plugin tracking every open thread's
 * anchor on every transaction, which is real scope beyond what this wave
 * needs to prove the anchor model works. A resolution that comes back
 * `null` (the anchored text was deleted, or concurrent edits moved it out
 * from under a stale reference) is shown as "no longer available" rather
 * than guessed at.
 *
 * ## Accepting a suggestion does not edit the document
 *
 * `suggestion.service.ts`'s own header names this: accept/reject flips
 * `status` and emits an event, nothing more — applying the proposed text is
 * a manual edit through the ordinary live session. The toast after Accept
 * says so, rather than implying the document just changed.
 */

type Tab = 'comments' | 'suggestions';

export function CommentsSuggestionsPanel({
  orgId,
  pageId,
  editorHandle,
}: {
  readonly orgId: string;
  readonly pageId: PageId;
  readonly editorHandle: DocsEditorHandle | null;
}) {
  const [tab, setTab] = useState<Tab>('comments');

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-line/50">
        <TabButton
          active={tab === 'comments'}
          onClick={() => {
            setTab('comments');
          }}
        >
          Comments
        </TabButton>
        <TabButton
          active={tab === 'suggestions'}
          onClick={() => {
            setTab('suggestions');
          }}
        >
          Suggestions
        </TabButton>
      </div>

      {tab === 'comments' ? (
        <CommentsTab orgId={orgId} pageId={pageId} editorHandle={editorHandle} />
      ) : (
        <SuggestionsTab orgId={orgId} pageId={pageId} editorHandle={editorHandle} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cnTab(active)}
      aria-current={active ? 'true' : undefined}
    >
      {children}
    </button>
  );
}

function cnTab(active: boolean): string {
  return active
    ? 'border-b-2 border-accent px-2 py-1.5 text-xs font-medium text-ink'
    : 'border-b-2 border-transparent px-2 py-1.5 text-xs text-ink-faint hover:text-ink-muted';
}

/**
 * Tracks whether the editor currently has a non-collapsed selection —
 * `RichTextEditor`'s own `onUpdate` pattern does not cover selection-only
 * changes (clicking without typing), so this listens to TipTap's own
 * `selectionUpdate` event directly.
 */
function useHasSelection(editorHandle: DocsEditorHandle | null): boolean {
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (editorHandle === null) return;

    const { editor } = editorHandle;
    const update = () => {
      setHasSelection(editor.state.selection.from !== editor.state.selection.to);
    };
    update();

    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editorHandle]);

  // Short-circuited here rather than by an extra `setHasSelection(false)`
  // branch above — that branch ran synchronously inside the effect body
  // (react-hooks/set-state-in-effect: "avoid calling setState() directly
  // within an effect"), and this is equivalent without it: a disconnected
  // editor never has a live selection regardless of what `hasSelection`
  // last held.
  return editorHandle !== null && hasSelection;
}

function revealAnchor(editorHandle: DocsEditorHandle | null, anchor: string): boolean {
  if (editorHandle === null) return false;
  const { editor, provider } = editorHandle;
  const pos = resolveAnchor(editor, provider, anchor);
  if (pos === null) return false;

  editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  return true;
}

/* -------------------------------------------------------------------------- *
 * Comments
 * -------------------------------------------------------------------------- */

function CommentsTab({
  orgId,
  pageId,
  editorHandle,
}: {
  readonly orgId: string;
  readonly pageId: PageId;
  readonly editorHandle: DocsEditorHandle | null;
}) {
  const comments = useQuery(pageCommentsQuery(orgId, pageId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const hasSelection = useHasSelection(editorHandle);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);
  const [editing, setEditing] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (editorHandle === null) throw new Error('The editor is not connected.');
      const range = buildSelectionAnchor(editorHandle.editor, editorHandle.provider);
      if (range === null) throw new Error('Select some text first.');
      return createComment({ pageId, anchorFrom: range.from, anchorTo: range.to, body: draft });
    },
    onSuccess: () => {
      invalidatePageComments(queryClient, orgId, pageId);
      setDraft(EMPTY_DOCUMENT);
      setComposing(false);
    },
    onError: (error) => {
      toast.failure('The comment was not posted', error);
    },
  });

  const edit = useMutation({
    mutationFn: (input: { commentId: CommentId; body: DocumentNode }) => updateComment(input),
    onSuccess: () => {
      invalidatePageComments(queryClient, orgId, pageId);
      setEditing(null);
    },
    onError: (error) => {
      toast.failure('The comment was not saved', error);
    },
  });

  const resolve = useMutation({
    mutationFn: (input: { commentId: CommentId; resolved: boolean }) => resolveComment(input),
    onSuccess: () => {
      invalidatePageComments(queryClient, orgId, pageId);
    },
    onError: (error) => {
      toast.failure('That did not go through', error);
    },
  });

  const remove = useMutation({
    mutationFn: (commentId: CommentId) => deleteComment({ commentId }),
    onSuccess: () => {
      invalidatePageComments(queryClient, orgId, pageId);
    },
    onError: (error) => {
      toast.failure('The comment was not deleted', error);
    },
  });

  const list = comments.data ?? [];

  return (
    <div className="space-y-3">
      {!composing && (
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasSelection}
          title={hasSelection ? undefined : 'Select some text in the document first'}
          onClick={() => {
            setComposing(true);
          }}
        >
          + Comment on selection
        </Button>
      )}

      {composing && (
        <RichTextEditor
          value={draft}
          placeholder="Write a comment…"
          onChange={setDraft}
          footer={
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={isEmptyDocument(draft) || create.isPending}
                onClick={() => {
                  create.mutate();
                }}
              >
                Comment
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setComposing(false);
                  setDraft(EMPTY_DOCUMENT);
                }}
              >
                Cancel
              </Button>
            </>
          }
        />
      )}

      {comments.isPending ? (
        <div aria-busy="true" className="space-y-1.5">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : list.length === 0 ? (
        <Empty title="No comments yet" description="Select text in the document to leave one." />
      ) : (
        <ul className="space-y-2">
          {list.map((comment) => (
            <li key={comment.commentId} className="rounded border border-line p-2">
              <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                {/* Matches `work/detail/comment-section.tsx`'s own comment
                    rows — a name with no face next to it here was the one
                    place Docs quietly diverged from Work's convention for
                    the identical kind of content (ai/phase-6.5-ui-polish.md
                    Wave 4). */}
                {comment.authorId !== null && (
                  <Avatar
                    userId={comment.authorId}
                    label={personOf(comment.authorId).label}
                    size="xs"
                  />
                )}
                <span className="font-medium text-ink-muted">
                  {comment.authorId === null ? 'Unknown author' : personOf(comment.authorId).label}
                </span>
                <span>{formatRelative(comment.createdAt)}</span>
                {comment.editedAt !== null && <span>(edited)</span>}
                {comment.resolvedAt !== null && <Badge tone="success">resolved</Badge>}
              </div>

              {comment.deletedAt !== null ? (
                <p className="mt-1 text-xs text-ink-faint italic">This comment was deleted.</p>
              ) : editing === comment.commentId ? (
                <EditBody
                  initial={comment.body}
                  pending={edit.isPending}
                  onCancel={() => {
                    setEditing(null);
                  }}
                  onSave={(body) => {
                    edit.mutate({ commentId: comment.commentId as CommentId, body });
                  }}
                />
              ) : (
                <>
                  <RichTextView value={comment.body} bare />
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-[11px]"
                      onClick={() => {
                        if (!revealAnchor(editorHandle, comment.anchorFrom)) {
                          toast.show('That text is no longer available.', { tone: 'neutral' });
                        }
                      }}
                    >
                      Reveal
                    </Button>
                    {comment.authorId !== null && comment.authorId === viewerId && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1 text-[11px]"
                        onClick={() => {
                          setEditing(comment.commentId);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-[11px]"
                      onClick={() => {
                        resolve.mutate({
                          commentId: comment.commentId as CommentId,
                          resolved: comment.resolvedAt === null,
                        });
                      }}
                    >
                      {comment.resolvedAt === null ? 'Resolve' : 'Reopen'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1 text-[11px] text-danger"
                      onClick={() => {
                        remove.mutate(comment.commentId as CommentId);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EditBody({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  readonly initial: unknown;
  readonly pending: boolean;
  readonly onSave: (body: DocumentNode) => void;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState<DocumentNode | null>(null);

  return (
    <RichTextEditor
      value={initial}
      onChange={setBody}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || body === null || isEmptyDocument(body)}
            onClick={() => {
              if (body !== null) onSave(body);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    />
  );
}

/* -------------------------------------------------------------------------- *
 * Suggestions
 * -------------------------------------------------------------------------- */

type SuggestionKind = 'insert' | 'delete' | 'replace';

function SuggestionsTab({
  orgId,
  pageId,
  editorHandle,
}: {
  readonly orgId: string;
  readonly pageId: PageId;
  readonly editorHandle: DocsEditorHandle | null;
}) {
  const suggestions = useQuery(pageSuggestionsQuery(orgId, pageId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const hasSelection = useHasSelection(editorHandle);
  const [composingKind, setComposingKind] = useState<SuggestionKind | null>(null);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);

  const create = useMutation({
    mutationFn: async (kind: SuggestionKind) => {
      if (editorHandle === null) throw new Error('The editor is not connected.');
      const { editor, provider } = editorHandle;

      const range =
        kind === 'insert'
          ? buildCollapsedAnchor(editor, provider, editor.state.selection.from)
          : buildSelectionAnchor(editor, provider);
      if (range === null) {
        throw new Error(kind === 'insert' ? 'Place the cursor first.' : 'Select some text first.');
      }

      return createSuggestion({
        pageId,
        anchorFrom: range.from,
        anchorTo: range.to,
        kind,
        proposedContent: kind === 'delete' ? null : draft,
      });
    },
    onSuccess: () => {
      invalidatePageSuggestions(queryClient, orgId, pageId);
      setDraft(EMPTY_DOCUMENT);
      setComposingKind(null);
    },
    onError: (error) => {
      toast.failure('The suggestion was not posted', error);
    },
  });

  const decide = useMutation({
    mutationFn: (input: { suggestionId: SuggestionId; status: 'accepted' | 'rejected' }) =>
      decideSuggestion(input),
    onSuccess: (_result, input) => {
      invalidatePageSuggestions(queryClient, orgId, pageId);
      if (input.status === 'accepted') {
        toast.show('Marked accepted — apply the change in the document yourself.', {
          tone: 'neutral',
        });
      }
    },
    onError: (error) => {
      toast.failure('That did not go through', error);
    },
  });

  const list = suggestions.data ?? [];
  const needsContent = composingKind === 'insert' || composingKind === 'replace';

  return (
    <div className="space-y-3">
      {composingKind === null && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={!hasSelection}
            title={hasSelection ? undefined : 'Select some text in the document first'}
            onClick={() => {
              setComposingKind('replace');
            }}
          >
            Suggest replacement
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!hasSelection}
            title={hasSelection ? undefined : 'Select some text in the document first'}
            onClick={() => {
              setComposingKind('delete');
            }}
          >
            Suggest deletion
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={editorHandle === null}
            onClick={() => {
              setComposingKind('insert');
            }}
          >
            Suggest insertion here
          </Button>
        </div>
      )}

      {composingKind !== null && (
        <div className="space-y-2">
          {needsContent && (
            <RichTextEditor
              value={draft}
              placeholder={composingKind === 'insert' ? 'Text to insert…' : 'Replacement text…'}
              onChange={setDraft}
            />
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={(needsContent && isEmptyDocument(draft)) || create.isPending}
              onClick={() => {
                create.mutate(composingKind);
              }}
            >
              Post suggestion
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setComposingKind(null);
                setDraft(EMPTY_DOCUMENT);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {suggestions.isPending ? (
        <div aria-busy="true" className="space-y-1.5">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : list.length === 0 ? (
        <Empty
          title="No suggestions yet"
          description="Propose an edit without changing the document directly."
        />
      ) : (
        <ul className="space-y-2">
          {list.map((suggestion) => (
            <SuggestionRow
              key={suggestion.suggestionId}
              suggestion={suggestion}
              authorLabel={
                suggestion.authorId === null
                  ? 'Unknown author'
                  : personOf(suggestion.authorId).label
              }
              isAuthor={suggestion.authorId !== null && suggestion.authorId === viewerId}
              onReveal={() => {
                if (!revealAnchor(editorHandle, suggestion.anchorFrom)) {
                  toast.show('That text is no longer available.', { tone: 'neutral' });
                }
              }}
              onDecide={(status) => {
                decide.mutate({ suggestionId: suggestion.suggestionId as SuggestionId, status });
              }}
              decidePending={decide.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  authorLabel,
  isAuthor,
  onReveal,
  onDecide,
  decidePending,
}: {
  readonly suggestion: SuggestionSummary;
  readonly authorLabel: string;
  readonly isAuthor: boolean;
  readonly onReveal: () => void;
  readonly onDecide: (status: 'accepted' | 'rejected') => void;
  readonly decidePending: boolean;
}) {
  const pending = suggestion.status === 'pending';

  return (
    <li className="rounded border border-line p-2">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        <Badge>{suggestion.kind}</Badge>
        {/* Same fix as the comment rows above — see that one's comment. */}
        {suggestion.authorId !== null && (
          <Avatar userId={suggestion.authorId} label={authorLabel} size="xs" />
        )}
        <span className="font-medium text-ink-muted">{authorLabel}</span>
        <span>{formatRelative(suggestion.createdAt)}</span>
        {!pending && (
          <Badge className={suggestion.status === 'accepted' ? 'text-success' : 'text-danger'}>
            {suggestion.status}
          </Badge>
        )}
      </div>

      {suggestion.proposedContent !== null && (
        <RichTextView value={suggestion.proposedContent} bare />
      )}

      <div className="mt-1 flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onReveal}>
          Reveal
        </Button>
        {pending && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[11px] text-success"
              disabled={decidePending}
              onClick={() => {
                onDecide('accepted');
              }}
            >
              Accept
            </Button>
            <ConfirmButton
              label={isAuthor ? 'Withdraw' : 'Reject'}
              confirmLabel={isAuthor ? 'Withdraw suggestion' : 'Reject suggestion'}
              size="sm"
              disabled={decidePending}
              onConfirm={() => {
                onDecide('rejected');
              }}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** A zero-width anchor `{from, to}` at a single collapsed position — the 'insert' suggestion's shape, distinct from `buildSelectionAnchor`'s non-empty-range requirement. */
function buildCollapsedAnchor(
  editor: DocsEditorHandle['editor'],
  provider: DocsEditorHandle['provider'],
  pos: number,
): { readonly from: string; readonly to: string } | null {
  const anchor = buildAnchor(editor, provider, pos);
  return anchor === null ? null : { from: anchor, to: anchor };
}
