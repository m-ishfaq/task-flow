import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type { BoardId, CardId, CommentId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { formatRelative } from '../../../lib/format.js';
import { useSession } from '../../../lib/session.js';
import { useOptimistic } from '../../../lib/optimistic.js';
import { useToast } from '../../../lib/toast-context.js';
import { cn } from '../../../lib/cn.js';
import { Avatar, Button } from '../../../components/primitives.js';
import { useMembers, type Person } from '../../org/use-members.js';
import { commentsQuery, patchCommentCount, patchComments, type Comment } from '../api.js';
import { RichTextEditor, RichTextView } from './rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from './rich-text.js';

/**
 * Comments on a card — one level of replies, and `@mention` in the editor.
 *
 * ## Why the edit control is author-only and the delete control is not
 *
 * Both rules come from the service, and this component mirrors them rather than
 * inventing them:
 *
 *   EDIT is author-only with NO permission override. Not "owners can also edit"
 *   — nobody can. A discussion where an administrator can put words in your
 *   mouth is not a record of anything, which is the entire reason the audit log
 *   is worth keeping. Because there is no override, showing the control to
 *   anyone else has no legitimate outcome — it can only end in a FORBIDDEN
 *   toast — so it is hidden for every comment that is not the viewer's own.
 *   That is an IDENTITY check (`comment.authorId === viewerId`), the same one
 *   `updateComment` makes inline rather than through `can()`, not a role
 *   decision this component would be re-deriving (CLAUDE.md, §8.2).
 *
 *   DELETE is author-or-moderator, and the event records which. Moderation is a
 *   real need, so unlike Edit there IS a legitimate way for someone else's
 *   Delete to succeed — the control stays visible to everyone and the server
 *   decides, same as every other permission-gated control in this app.
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
 * ## Replies are one level, matching the service
 *
 * `comment.service.ts`'s `createComment` refuses a reply to a reply, so the
 * grouping below only ever needs two tiers: top-level comments, and each one's
 * flat list of replies. `Reply` is offered on a top-level comment only —
 * `CommentRow` simply is not given an `onReply` for a row that is itself a
 * reply, rather than this component trying to predict what the server would
 * say about a deeper one.
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

/**
 * The posting logic shared by the top-level composer and every open reply box.
 *
 * One hook rather than one mutation, because a reply box is a NEW component
 * instance per parent comment (`ReplyComposer`) and each needs its own draft
 * and its own in-flight state — two people replying to two different comments
 * must not share a text box. `parentCommentId` is the only thing that
 * distinguishes a top-level post from a reply; everything else — the optimistic
 * insert, the rollback, the restore-draft-on-failure — is identical.
 */
function useCommentComposer({
  orgId,
  boardId,
  cardId,
  parentCommentId,
  failureTitle,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly parentCommentId: string | null;
  readonly failureTitle: string;
}) {
  const optimistic = useOptimistic();
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);

  const handlers = optimistic<DocumentNode>({
    keys: [keys.comments(orgId, cardId), keys.cardsOfBoard(orgId, boardId)],
    patch: (client, body) => {
      patchComments(client, orgId, cardId, (current) => [
        ...current,
        {
          commentId: nextPendingId(current),
          cardId,
          parentCommentId,
          /* Null, and rendered as "Posting…" rather than as the author's name.
             The row below never shows an author line for anything pending, so
             this value is never displayed. */
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
    failureTitle,
  });

  const post = useMutation({
    mutationFn: (body: DocumentNode) =>
      api.work.comments.create.mutate({
        cardId,
        body,
        parentCommentId,
      }),

    ...handlers,

    /* Extends the helper's `onError` rather than replacing it — the delegation
       on the first line is what keeps the rollback and the toast. Dropping it
       would leave the placeholder in the thread as a comment that does not
       exist. */
    onError: (error, body, context) => {
      handlers.onError(error, body, context);
      /* The draft is put BACK, and only if nothing new has been typed since —
         the same rule as the new-card field. Having shown someone their text
         in the thread, losing it is worse than the failure itself. */
      setDraft((current) => (isEmptyDocument(current) ? body : current));
    },
  });

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;
    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    post.mutate(body);
  };

  return { draft, setDraft, submit, isPending: post.isPending };
}

export interface CommentSectionProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
}

export function CommentSection({ orgId, boardId, cardId }: CommentSectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const comments = useQuery(commentsQuery(orgId, cardId));
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const optimistic = useOptimistic();
  const [editing, setEditing] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const composer = useCommentComposer({
    orgId,
    boardId,
    cardId,
    parentCommentId: null,
    failureTitle: 'The comment was not posted',
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
           its place would make the thread jump twice for one click. Replies to
           a deleted comment are untouched: the service does not cascade the
           tombstone, so neither does this. */
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

  const all = comments.data ?? [];
  const topLevel = all.filter((comment) => comment.parentCommentId === null);
  const repliesOf = (parentId: string): readonly Comment[] =>
    all.filter((comment) => comment.parentCommentId === parentId);

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <MessageSquare aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Comments
      </h3>

      <ul className="space-y-3">
        {topLevel.map((comment) => (
          <li key={comment.commentId} className="space-y-2">
            <CommentRow
              comment={comment}
              viewerId={viewerId}
              personOf={personOf}
              isEditing={editing === comment.commentId}
              onStartEdit={() => {
                setEditing(comment.commentId);
              }}
              onCancelEdit={() => {
                setEditing(null);
              }}
              onSaveEdit={(body) => {
                edit.mutate({ commentId: comment.commentId as CommentId, body });
              }}
              editPending={edit.isPending}
              onDelete={() => {
                remove.mutate(comment.commentId as CommentId);
              }}
              onReply={
                isPending(comment.commentId)
                  ? undefined
                  : () => {
                      setReplyingTo((current) =>
                        current === comment.commentId ? null : comment.commentId,
                      );
                    }
              }
            />

            {repliesOf(comment.commentId).length > 0 && (
              <ul className="ml-6 space-y-2 border-l border-line pl-3">
                {repliesOf(comment.commentId).map((reply) => (
                  <li key={reply.commentId}>
                    <CommentRow
                      comment={reply}
                      viewerId={viewerId}
                      personOf={personOf}
                      isEditing={editing === reply.commentId}
                      onStartEdit={() => {
                        setEditing(reply.commentId);
                      }}
                      onCancelEdit={() => {
                        setEditing(null);
                      }}
                      onSaveEdit={(body) => {
                        edit.mutate({ commentId: reply.commentId as CommentId, body });
                      }}
                      editPending={edit.isPending}
                      onDelete={() => {
                        remove.mutate(reply.commentId as CommentId);
                      }}
                      // No `onReply` — replies are one level (CLAUDE.md, header note).
                    />
                  </li>
                ))}
              </ul>
            )}

            {replyingTo === comment.commentId && (
              <div className="ml-6 border-l border-line pl-3">
                <ReplyComposer
                  orgId={orgId}
                  boardId={boardId}
                  cardId={cardId}
                  parentCommentId={comment.commentId}
                  onDone={() => {
                    setReplyingTo(null);
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <RichTextEditor
        value={composer.draft}
        placeholder="Write a comment… (@ to mention someone)"
        onChange={composer.setDraft}
        footer={
          /* Not disabled while pending, and the editor clears on SUBMIT rather
             than on success — a thread is written in a burst, and putting a
             round trip between two replies is what makes people stop using it.
             The comment is already visible in the list above by the time this
             runs. */
          <Button
            size="sm"
            variant="primary"
            disabled={isEmptyDocument(composer.draft)}
            onClick={composer.submit}
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

/** An inline reply box under a top-level comment, mounted only while open. */
function ReplyComposer({
  orgId,
  boardId,
  cardId,
  parentCommentId,
  onDone,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly parentCommentId: string;
  readonly onDone: () => void;
}) {
  const composer = useCommentComposer({
    orgId,
    boardId,
    cardId,
    parentCommentId,
    failureTitle: 'The reply was not posted',
  });

  return (
    <RichTextEditor
      value={composer.draft}
      placeholder="Write a reply… (@ to mention someone)"
      onChange={composer.setDraft}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={isEmptyDocument(composer.draft)}
            onClick={() => {
              composer.submit();
              onDone();
            }}
          >
            Reply
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </>
      }
    />
  );
}

/** One comment or reply — the author line, the body, and its controls. */
function CommentRow({
  comment,
  viewerId,
  personOf,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  onReply,
}: {
  readonly comment: Comment;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: () => void;
  /** Omitted for a reply — one level of nesting only (header note). */
  readonly onReply?: (() => void) | undefined;
}) {
  const pending = isPending(comment.commentId);

  return (
    <div className={cn('space-y-1', pending && 'opacity-60')}>
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {pending ? (
          <span>Posting…</span>
        ) : (
          <>
            {/* `personOf` falls back to the raw id itself when the author is
                not in this org's member list — someone who has since left,
                per its own doc comment — so this never regresses to a blank
                line, only to what it already rendered before. */}
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
          </>
        )}
      </div>

      {comment.deletedAt !== null ? (
        <p className="text-xs text-ink-faint italic">This comment was deleted.</p>
      ) : pending ? (
        /* Body only. Edit, Delete and Reply would send an id the server has
           never seen, so they arrive with the real row a moment later. */
        <RichTextView value={comment.body} />
      ) : isEditing ? (
        <EditComment
          initial={comment.body}
          pending={editPending}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      ) : (
        <>
          <RichTextView value={comment.body} />
          <div className="flex gap-1">
            {/* Edit is hidden for anyone but the author — there is no
                override, ever (updateComment), so showing it to someone else
                could only ever end in a FORBIDDEN toast. Delete stays visible
                to everyone: a moderator without `comment:delete` gets a real
                denial from the server, the same as every other
                permission-gated control here. */}
            {comment.authorId !== null && comment.authorId === viewerId && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-[11px]"
                onClick={onStartEdit}
              >
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onDelete}>
              Delete
            </Button>
            {onReply !== undefined && (
              <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onReply}>
                Reply
              </Button>
            )}
          </div>
        </>
      )}
    </div>
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
