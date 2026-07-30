import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardId, CommentId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { formatRelative } from '../../../lib/format.js';
import { useSession } from '../../../lib/session.js';
import { Button } from '../../../components/primitives.js';
import { ErrorText } from '../../../components/error-view.js';
import { commentsQuery } from '../api.js';
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
 */

export interface CommentSectionProps {
  readonly orgId: string;
  readonly cardId: CardId;
}

export function CommentSection({ orgId, cardId }: CommentSectionProps) {
  const queryClient = useQueryClient();
  const comments = useQuery(commentsQuery(orgId, cardId));
  const viewerId = useSession((state) => state.sessionId);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.comments(orgId, cardId) });

  const post = useMutation({
    mutationFn: (body: DocumentNode) => api.work.comments.create.mutate({ cardId, body }),
    onSuccess: async () => {
      setDraft(EMPTY_DOCUMENT);
      await refresh();
    },
  });

  const edit = useMutation({
    mutationFn: (input: { commentId: CommentId; body: DocumentNode }) =>
      api.work.comments.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (commentId: CommentId) => api.work.comments.delete.mutate({ commentId }),
    onSuccess: refresh,
  });

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Comments</h3>

      <ul className="space-y-3">
        {(comments.data ?? []).map((comment) => (
          <li key={comment.commentId} className="space-y-1">
            <div className="flex items-baseline gap-2 text-[11px] text-ink-faint">
              <span>{comment.authorId ?? 'Unknown author'}</span>
              <span>{formatRelative(comment.createdAt)}</span>
              {comment.editedAt !== null && <span>(edited)</span>}
            </div>

            {comment.deletedAt !== null ? (
              <p className="text-xs text-ink-faint italic">This comment was deleted.</p>
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
          <Button
            size="sm"
            variant="primary"
            disabled={post.isPending || isEmptyDocument(draft)}
            onClick={() => {
              post.mutate(draft);
            }}
          >
            {post.isPending ? 'Posting…' : 'Comment'}
          </Button>
        }
      />

      {post.isError && <ErrorText error={post.error} />}
      {edit.isError && <ErrorText error={edit.error} />}
      {remove.isError && <ErrorText error={remove.error} />}
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
