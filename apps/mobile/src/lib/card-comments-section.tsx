import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useSession } from './use-session.js';
import { RichTextView } from './rich-text-view.js';
import { liveFormatParser, parseFormattedText, serializeToText } from './rich-text-compose.js';
import { activeMentionQuery, insertMention, type PendingMention } from './message-compose.js';
import { Avatar } from './avatar.js';
import { useMembers, type Member } from './use-members.js';
import { cardQueryKey, commentsQueryKey, type Comment } from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * Comments — closing the last Work-parity gap: edit, delete, and one level
 * of replies, ported from `apps/web`'s own `CommentSection`.
 * `work.comments.list` shares TipTap-JSON's `RichTextDocument` shape with
 * a card's own description, so existing comments reuse `RichTextView`
 * unchanged. Posting AND editing both go through `parseFormattedText`
 * (`rich-text-compose.ts`) over a `MarkdownTextInput` — the same native
 * `**bold**`/`[text](url)`/`- `/`1. ` composing `DescriptionField` below
 * and Chat's message composer already use, not a plain `TextInput` plus
 * `plainParagraph` anymore. `@mention` composing in the comment box is
 * still explicitly NOT ported — that lives only in Chat's message composer
 * (`message-compose.ts`), and adding a second, independent mention-
 * composing surface (a member picker, a query dropdown) is real, separate
 * work; `parseFormattedText`'s `mentions` argument is simply omitted here,
 * the same way Work's callers were always meant to use it (that function's
 * own header).
 *
 * **Edit is author-only with NO override, mirrored as a client-side
 * IDENTITY check rather than a role decision** — `comment.authorId ===
 * viewerId`, the same check `updateComment` makes inline on the server,
 * not `can()`. There is no legitimate way for anyone else's Edit to
 * succeed, so the control is hidden rather than shown-and-refused.
 * `onStartEdit` seeds the box from `serializeToText(comment.body)` — the
 * TipTap-JSON round-trip, not `comment.bodyText` (the server's plain-text
 * projection) — so formatting like **bold** and [links](url) survive into
 * the edit. `parseFormattedText` on save converts the markdown back to
 * TipTap JSON, preserving whatever was already there plus any new syntax
 * the editor composes during the edit.
 * **Delete is shown to the author, or a caller who `canModerate`** —
 * `comment:delete` is Admin-and-Owner only by role
 * (`packages/policy/src/roles.ts`), so this used to render for every
 * Member on every comment they did not write and let their tap come back
 * FORBIDDEN (Phase 15 §1's sweep, mirroring the identical fix in
 * `apps/web/src/features/work/detail/comment-section.tsx`). `canModerate`
 * is `cards.get`'s `capabilities.moderateComments` — computed per-card,
 * server-side, since `comment:delete` is resource-scoped (a tuple on this
 * card's board can grant it without any org-wide role change) — passed
 * down from `card/[cardId].tsx`'s own already-fetched card query rather
 * than fetched a second time here. The author's own Delete still needs
 * nothing beyond `comment:create`, same as the service. Neither mutation
 * is optimistic — matching this screen's own already-shipped
 * status/assignee/label sections rather than web's optimistic-with-a-
 * fake-pending-id complexity, which exists there only because posting
 * itself is optimistic; posting stays round-trip here, as it already was.
 *
 * **Replies are ONE level, matching the service** — `comment.service.ts`
 * refuses a reply to a reply, so `repliesOf` only ever needs two tiers.
 * `onReply` is offered on a top-level comment only, the same restriction
 * `apps/web`'s own `CommentRow` enforces by simply not passing the prop
 * to a reply row.
 *
 * A deleted comment (`deletedAt !== null`) is tombstoned server-side —
 * `body`/`bodyText` come back empty, not omitted, so the thread's shape
 * survives, including any replies underneath it (the service does not
 * cascade a tombstone, so neither does this UI) — rendered here as a
 * plain "Comment deleted" placeholder rather than an empty `RichTextView`
 * (which would render nothing and look like a blank comment, not a
 * deleted one).
 *
 * **Visually, "very messy" (2026-08-22 device feedback) meant no boundary
 * between one comment and the next and no author avatar** — both are
 * fixed here, not by inventing new structure. Each top-level thread's
 * `CommentRow` sits in `commentBubble` (`surfaceHover`, one shade lighter
 * than this `Section`'s own `surfaceRaised` card, the same elevation step
 * `assigneeChip`/`priorityChip` already use for "a distinct thing sitting
 * on top of its section"), and each reply's existing `commentReply`
 * indent gained a `surfaceSunken` fill — one shade DARKER, reading as
 * "tucked inside" its parent rather than merely float-indented under a
 * thin line. `CommentRow` itself is otherwise unchanged except for the
 * `Avatar` next to the author name, matching web's own `CommentRow` (which
 * has always rendered one) — a real, one-line gap on this screen, not a
 * deliberate mobile omission.
 */
export function CommentsSection({
  cardId,
  canModerate,
}: {
  readonly cardId: CardId;
  /** `cards.get`'s `capabilities.moderateComments` — see the header note. */
  readonly canModerate: boolean;
}) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const { personOf, people } = useMembers();
  const [draft, setDraft] = useState('');
  const [pendingMentions, setPendingMentions] = useState<readonly PendingMention[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [replyMentions, setReplyMentions] = useState<readonly PendingMention[]>([]);

  const comments = useQuery({
    queryKey: commentsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.comments.list.query({ cardId })),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: commentsQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
    ]);

  const post = useMutation({
    mutationFn: (input: {
      body: string;
      parentCommentId: string | null;
      mentions: readonly PendingMention[];
    }) =>
      apiClient.work.comments.create.mutate({
        cardId,
        body: parseFormattedText(input.body, input.mentions),
        parentCommentId: input.parentCommentId,
      }),
    onSuccess: (_result, input) => {
      if (input.parentCommentId === null) {
        setDraft('');
        setPendingMentions([]);
      } else {
        setReplyDraft('');
        setReplyMentions([]);
        setReplyingTo(null);
      }
    },
    onSettled: refresh,
  });

  const edit = useMutation({
    mutationFn: (input: { commentId: string; text: string }) =>
      apiClient.work.comments.update.mutate({
        commentId: input.commentId,
        body: parseFormattedText(input.text),
      }),
    onSuccess: () => {
      setEditingId(null);
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (commentId: string) => apiClient.work.comments.delete.mutate({ commentId }),
    onSettled: refresh,
  });

  const all = comments.data ?? [];
  const topLevel = all.filter((comment) => comment.parentCommentId === null);
  const repliesOf = (parentId: string): readonly Comment[] =>
    all.filter((comment) => comment.parentCommentId === parentId);

  return (
    <Section label="Comments">
      {comments.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {topLevel.map((comment) => (
        <View key={comment.commentId} style={styles.commentThread}>
          <View style={styles.commentBubble}>
            <CommentRow
              comment={comment}
              viewerId={userId}
              canModerate={canModerate}
              personOf={personOf}
              isEditing={editingId === comment.commentId}
              editDraft={editDraft}
              onEditDraftChange={setEditDraft}
              editPending={edit.isPending}
              onStartEdit={() => {
                setEditingId(comment.commentId);
                setEditDraft(
                  serializeToText(comment.body as Parameters<typeof serializeToText>[0]),
                );
              }}
              onCancelEdit={() => {
                setEditingId(null);
              }}
              onSaveEdit={() => {
                if (editDraft.trim().length === 0) return;
                edit.mutate({ commentId: comment.commentId, text: editDraft.trim() });
              }}
              onDelete={() => {
                remove.mutate(comment.commentId);
              }}
              onReply={() => {
                setReplyDraft('');
                setReplyingTo((current) =>
                  current === comment.commentId ? null : comment.commentId,
                );
              }}
            />
          </View>

          {repliesOf(comment.commentId).map((reply) => (
            <View key={reply.commentId} style={styles.commentReply}>
              <CommentRow
                comment={reply}
                viewerId={userId}
                canModerate={canModerate}
                personOf={personOf}
                isEditing={editingId === reply.commentId}
                editDraft={editDraft}
                onEditDraftChange={setEditDraft}
                editPending={edit.isPending}
                onStartEdit={() => {
                  setEditingId(reply.commentId);
                  setEditDraft(
                    serializeToText(reply.body as Parameters<typeof serializeToText>[0]),
                  );
                }}
                onCancelEdit={() => {
                  setEditingId(null);
                }}
                onSaveEdit={() => {
                  if (editDraft.trim().length === 0) return;
                  edit.mutate({ commentId: reply.commentId, text: editDraft.trim() });
                }}
                onDelete={() => {
                  remove.mutate(reply.commentId);
                }}
              />
            </View>
          ))}

          {replyingTo === comment.commentId && (
            <View style={styles.commentReply}>
              <CommentComposer
                draft={replyDraft}
                onDraftChange={setReplyDraft}
                onMentionRecorded={(mention) => {
                  setReplyMentions((current) => [...current, mention]);
                }}
                people={people}
                viewerId={userId}
                placeholder="Write a reply…"
                autoFocus
              />
              <View style={styles.modalActions}>
                <Pressable
                  style={styles.modalPrimaryButton}
                  disabled={replyDraft.trim().length === 0 || post.isPending}
                  onPress={() => {
                    post.mutate({
                      body: replyDraft.trim(),
                      parentCommentId: comment.commentId,
                      mentions: replyMentions,
                    });
                  }}
                >
                  <Text style={styles.modalPrimaryButtonText}>Reply</Text>
                </Pressable>
                <Pressable
                  style={styles.modalSecondaryButton}
                  onPress={() => {
                    setReplyingTo(null);
                  }}
                >
                  <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      ))}
      {topLevel.length === 0 && !comments.isPending && (
        <Text style={styles.label}>No comments yet.</Text>
      )}

      <CommentComposer
        draft={draft}
        onDraftChange={setDraft}
        onMentionRecorded={(mention) => {
          setPendingMentions((current) => [...current, mention]);
        }}
        people={people}
        viewerId={userId}
        placeholder="Add a comment…"
        trailing={
          <Pressable
            style={styles.sendButton}
            disabled={draft.trim().length === 0 || post.isPending}
            onPress={() => {
              post.mutate({ body: draft.trim(), parentCommentId: null, mentions: pendingMentions });
            }}
          >
            {post.isPending ? (
              <ActivityIndicator color={colors.accentInk.hex} />
            ) : (
              <Text style={styles.sendButtonText}>Send</Text>
            )}
          </Pressable>
        }
      />
      {(post.isError || edit.isError || remove.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(post.error ?? edit.error ?? remove.error)?.error.message ??
            'That action could not be completed.'}
        </Text>
      )}
    </Section>
  );
}

/**
 * `@mention` composing for a card comment — the gap named in `apps/mobile/
 * README.md`: Chat's own composer (`message-composer.tsx`) has had this
 * since the rich-text-editor pass; Work's comment composer never did.
 * Reuses `message-compose.ts`'s cursor logic verbatim (`activeMentionQuery`/
 * `insertMention` are chat-agnostic pure text/cursor functions, not
 * duplicated here), but is its OWN small component rather than the shared
 * `<MessageComposer />` — that component also owns an icon-styled send
 * button and an optional attach affordance shaped for Chat's one-row
 * WhatsApp layout, and `CommentsSection` below needs two different button
 * arrangements the shared component cannot express: the top-level composer
 * wants a button BESIDE the input, and a reply wants Reply/Cancel BELOW it,
 * entirely outside this component. `trailing` is that seam — rendered
 * inside this component's own row when supplied (the top-level composer),
 * left absent otherwise (a reply, whose Reply/Cancel row is a sibling the
 * caller renders itself, exactly as it already did before this component
 * existed).
 *
 * `CommentsSection` had this exact input+dropdown logic duplicated once
 * already (a plain composer for a new top-level comment, a second copy for
 * whichever reply box is open) with neither getting mentions — extracting
 * it here means the two call sites share one implementation instead of one
 * gaining mentions and the other silently not.
 */
function CommentComposer({
  draft,
  onDraftChange,
  onMentionRecorded,
  people,
  viewerId,
  placeholder,
  autoFocus,
  trailing,
}: {
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly onMentionRecorded: (mention: PendingMention) => void;
  readonly people: readonly Member[];
  readonly viewerId: string | null;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
  /** Rendered inside this component's own row, after the input — see this
   *  component's own header for why only the top-level composer supplies one. */
  readonly trailing?: ReactNode;
}) {
  // `undefined` until the first `onSelectionChange` event, matching
  // `message-composer.tsx`'s identical reasoning: the very first render
  // leaves the input's cursor fully native rather than forcing a guess.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const clampedSelection =
    selection === undefined
      ? undefined
      : {
          start: Math.min(selection.start, draft.length),
          end: Math.min(selection.end, draft.length),
        };

  const active = activeMentionQuery(draft, clampedSelection?.end ?? draft.length);
  const mentionCandidates =
    active === null
      ? []
      : people
          .filter((member) => member.userId !== viewerId)
          .filter((member) =>
            (member.displayName ?? member.email).toLowerCase().includes(active.query.toLowerCase()),
          )
          .slice(0, 6);

  const pickMention = (member: Member): void => {
    if (active === null) return;
    const label = member.displayName ?? member.email;
    const result = insertMention(draft, active, { userId: member.userId, label });
    onDraftChange(result.draft);
    onMentionRecorded(result.mention);
    setSelection({ start: result.cursor, end: result.cursor });
  };

  return (
    <>
      {active !== null && mentionCandidates.length > 0 && (
        <ScrollView style={styles.mentionList} keyboardShouldPersistTaps="handled">
          {mentionCandidates.map((member) => (
            <Pressable
              key={member.userId}
              style={styles.mentionRow}
              onPress={() => {
                pickMention(member);
              }}
            >
              <Text style={styles.mentionRowText}>{member.displayName ?? member.email}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <View style={styles.composerRow}>
        <MarkdownTextInput
          value={draft}
          onChangeText={onDraftChange}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection);
          }}
          selection={clampedSelection}
          placeholder={placeholder}
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
          autoFocus={autoFocus}
          parser={liveFormatParser}
          markdownStyle={{
            syntax: { color: colors.inkFaint.hex },
            link: { color: colors.accent.hex },
          }}
        />
        {trailing}
      </View>
    </>
  );
}

function CommentRow({
  comment,
  viewerId,
  canModerate,
  personOf,
  isEditing,
  editDraft,
  onEditDraftChange,
  editPending,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onReply,
}: {
  readonly comment: Comment;
  readonly viewerId: string | null;
  readonly canModerate: boolean;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly isEditing: boolean;
  readonly editDraft: string;
  readonly onEditDraftChange: (text: string) => void;
  readonly editPending: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: () => void;
  readonly onDelete: () => void;
  /** Omitted for a reply — one level of nesting only (this section's own header). */
  readonly onReply?: (() => void) | undefined;
}) {
  const isOwn = comment.authorId === viewerId;
  const author =
    comment.authorId === null ? 'Unknown' : isOwn ? 'You' : personOf(comment.authorId).label;

  return (
    <View style={styles.commentRow}>
      <View style={styles.commentMeta}>
        <Avatar label={author} size={20} />
        <Text style={styles.commentAuthor}>{author}</Text>
        <Text style={styles.commentTime}>
          {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
        </Text>
        {comment.editedAt !== null && <Text style={styles.commentTime}>(edited)</Text>}
      </View>

      {comment.deletedAt !== null ? (
        <Text style={styles.commentDeleted}>Comment deleted</Text>
      ) : isEditing ? (
        <View style={styles.editRow}>
          <MarkdownTextInput
            value={editDraft}
            onChangeText={onEditDraftChange}
            style={styles.editInput}
            multiline
            autoFocus
            parser={liveFormatParser}
            markdownStyle={{
              syntax: { color: colors.inkFaint.hex },
              link: { color: colors.accent.hex },
            }}
          />
          <View style={styles.editActions}>
            <Pressable onPress={onCancelEdit}>
              <Text style={styles.editCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.editSaveButton}
              disabled={editPending || editDraft.trim().length === 0}
              onPress={onSaveEdit}
            >
              {editPending ? (
                <ActivityIndicator color={colors.accentInk.hex} />
              ) : (
                <Text style={styles.editSaveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <RichTextView document={comment.body} />
          <View style={styles.commentActions}>
            {isOwn && (
              <Pressable onPress={onStartEdit}>
                <Text style={styles.commentActionText}>Edit</Text>
              </Pressable>
            )}
            {(isOwn || canModerate) && (
              <Pressable onPress={onDelete}>
                <Text style={styles.commentActionText}>Delete</Text>
              </Pressable>
            )}
            {onReply !== undefined && (
              <Pressable onPress={onReply}>
                <Text style={styles.commentActionText}>Reply</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
    </View>
  );
}
