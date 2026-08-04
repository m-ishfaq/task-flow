import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, CommentId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { formatRelative } from '../../../lib/format.js';
import { useSession } from '../../../lib/session.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { useToast } from '../../../lib/toast-context.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../../components/primitives.js';
import { commentsQuery, patchCommentCount, patchComments, type Comment } from '../api.js';
import { RichTextEditor, RichTextView } from './rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from './rich-text.js';

/**
 * Comments on a card.
 *
 * ## Why the edit control is author-only and the delete control is not
 *
 * Both rules come from the service, and this component mirrors them rather than
 * inventing them:
 *
 *   EDIT is author-only with NO permission override. Not "owners can also edit"
 *   — nobody can. A discussion where an administrator can put words in your
 *   mouth is not a record of anything, which is the entire reason the audit log
 *   is worth keeping.
 *
 *   DELETE is author-or-moderator, and the event records which. Moderation is a
 *   real need; rewriting is not.
 *
 * Commenting is `comment:create`, never `card:update`. That separation is why
 * the `commenter` relation exists at all (§8.2): someone can be given a voice on
 * a board without edit rights, and merging the two permissions would make that
 * unexpressible.
 *
 * A deleted comment is rendered as a tombstone rather than removed. The thread
 * is a conversation, and silently closing the gap makes the replies around it
 * read as answers to something nobody said.
 *
 * ## The board is invalidated, not just the thread
 *
 * `commentCount` lives on the CARD row and is drawn as `💬 3` on the board tile
 * behind this panel. These mutations used to invalidate `keys.comments` alone,
 * so the badge kept its old number until something else happened to refetch the
 * board — the exact drift `invalidateCard` exists to prevent, and invisible
 * because a stale badge looks precisely like a correct one. That is why this
 * component now needs a `boardId`.
 */

/**
 * A comment that exists only in the cache.
 *
 * The server assigns the id, so an optimistic comment has to carry a made-up one
 * — and the prefix is what stops that lie leaking into a request. A row wearing
 * it renders without Edit and Delete, because both would send an id no row has:
 * `checklists.addItem` declines to be optimistic for exactly this reason, and
 * the difference here is that a comment's identity is not on screen the way a
 * card's `WEB-142` is, so the body can appear immediately as long as the
 * controls that need the id wait.
 *
 * The number is derived from the CACHE rather than from a counter. `Math.random()`
 * is banned workspace-wide, and the two obvious places to keep a counter are both
 * lint errors that are right on the merits: a module-level `let` is shared by
 * every panel ever mounted, and a ref read while building the mutation options is
 * read during render. Scanning for the highest pending number needs no state at
 * all and gives exactly the guarantee a React key requires — distinct from the
 * other rows on screen right now. Resolved comments take their placeholders with
 * them, so the numbers restart rather than climbing forever.
 */
const PENDING_PREFIX = 'pending:';

function isPending(commentId: string): boolean {
  return commentId.startsWith(PENDING_PREFIX);
}

function nextPendingId(comments: readonly Comment[]): string {
  let highest = 0;
  for (const comment of comments) {
    if (!isPending(comment.commentId)) continue;
    const seq = Number.parseInt(comment.commentId.slice(PENDING_PREFIX.length), 10);
    if (Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return `${PENDING_PREFIX}${String(highest + 1)}`;
}

export interface CommentSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
}

export function CommentSection({ orgId, boardId, cardId }: CommentSectionProps) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const toast = useToast();
  const comments = useQuery(commentsQuery(orgId, cardId));
  const viewerId = useSession((state) => state.sessionId);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);
  const [editing, setEditing] = useState<string | null>(null);

  const optimisticPost = optimistic<DocumentNode>({
    keys: [keys.comments(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
    patch: (client, body) => {
      patchComments(client, orgId, cardId, (current) => [
        ...current,
        {
          commentId: nextPendingId(current),
          cardId,
          /* Null, and rendered as "Posting…" rather than as the author's name.
             The session store holds a session id, not a user id, so this client
             genuinely does not know who it is — and "Unknown author" against
             your own sentence reads as data loss. */
          authorId: null,
          body,
          bodyText: '',
          editedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      patchCommentCount(client, orgId, boardId, cardId, 1);
    },
    failureTitle: 'The comment was not posted',
  });

  const post = useMutation({
    mutationFn: (body: DocumentNode) => api.work.comments.create.mutate({ cardId, body }),

    ...optimisticPost,

    /* Extends the helper's `onError` rather than replacing it — the delegation on
       the first line is what keeps the rollback and the toast. Dropping it would
       leave the placeholder in the thread as a comment that does not exist. */
    onError: (error, body, context) => {
      optimisticPost.onError(error, body, context);
      /* The draft is put BACK, and only if nothing new has been typed since —
         the same rule as the new-card field. Having shown someone their comment
         in the thread, losing the text is worse than the failure itself. */
      setDraft((current) => (isEmptyDocument(current) ? body : current));
    },
  });

  const edit = useMutation({
    mutationFn: (input: { commentId: CommentId; body: DocumentNode }) =>
      api.work.comments.update.mutate(input),
    /* Deliberately NOT optimistic, unlike posting and deleting. Closing the
       editor the instant Save is clicked means a rollback restores the ORIGINAL
       body and the rewrite is gone — the editor is the only place that text
       exists. Keeping it open until the server answers costs a round trip on an
       uncommon action and never discards work. Same reasoning as the card
       title's explicit save. */
    onSuccess: () => {
      setEditing(null);
    },
    onError: (error) => {
      toast.failure('The comment was not saved', error);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.comments(orgId, cardId) }),
        queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
      ]);
    },
  });

  const remove = useMutation({
    mutationFn: (commentId: CommentId) => api.work.comments.delete.mutate({ commentId }),

    ...optimistic<CommentId>({
      keys: [keys.comments(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
      patch: (client, commentId) => {
        /* Tombstoned, not dropped — matching the service's soft delete. Removing
           the row optimistically and having the refetch put a tombstone back in
           its place would make the thread jump twice for one click. */
        patchComments(client, orgId, cardId, (current) =>
          current.map((comment) =>
            comment.commentId === commentId
              ? { ...comment, deletedAt: new Date().toISOString() }
              : comment,
          ),
        );
        /* `recountComments` excludes soft-deleted rows, so the badge does drop
           by one even though the row stays. */
        patchCommentCount(client, orgId, boardId, cardId, -1);
      },
      failureTitle: 'The comment was not deleted',
    }),
  });

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Comments</h3>

      <ul className="space-y-3">
        {(comments.data ?? []).map((comment) => (
          <li
            key={comment.commentId}
            className={cn('space-y-1', isPending(comment.commentId) && 'opacity-60')}
          >
            <div className="flex items-baseline gap-2 text-[11px] text-ink-faint">
              {isPending(comment.commentId) ? (
                <span>Posting…</span>
              ) : (
                <>
                  <span>{comment.authorId ?? 'Unknown author'}</span>
                  <span>{formatRelative(comment.createdAt)}</span>
                  {comment.editedAt !== null && <span>(edited)</span>}
                </>
              )}
            </div>

            {comment.deletedAt !== null ? (
              <p className="text-xs text-ink-faint italic">This comment was deleted.</p>
            ) : isPending(comment.commentId) ? (
              /* Body only. Edit and Delete would send an id the server has never
                 seen, so they arrive with the real row a moment later. */
              <RichTextView value={comment.body} />
            ) : editing === comment.commentId ? (
              <EditComment
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
                <RichTextView value={comment.body} />
                <div className="flex gap-1">
                  {/* Both controls are shown to everyone; the server decides.
                      The client does not know who the author is — the API
                      returns an `authorId`, not "was this you" — and guessing
                      from a session id would be a second authorization model
                      that drifts from the one that is enforced. */}
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
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-[11px]"
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

      <RichTextEditor
        value={draft}
        placeholder="Write a comment…"
        onChange={setDraft}
        footer={
          /* Not disabled while pending, and the editor clears on SUBMIT rather
             than on success — a thread is written in a burst, and putting a
             round trip between two replies is what makes people stop using it.
             The comment is already visible in the list above by the time this
             runs. */
          <Button
            size="sm"
            variant="primary"
            disabled={isEmptyDocument(draft)}
            onClick={() => {
              const body = draft;
              setDraft(EMPTY_DOCUMENT);
              post.mutate(body);
            }}
          >
            Comment
          </Button>
        }
      />

      {/* No inline error rows — every mutation here reports through a toast. */}
      {viewerId === null && <p className="text-[11px] text-ink-faint">Not signed in.</p>}
    </section>
  );
}

function EditComment({
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
