import { asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type CardId, type CommentId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { commentCreated, commentDeleted, commentUpdated } from './events.js';
import { loadCard } from './card.service.js';
import { recountComments } from './counters.js';
import { flattenToText, mentionedUserIds, type RichTextNode } from './richtext.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, type WorkActor } from './shared.js';

/**
 * Card comments (PLAN.md §3.1, §8.7).
 *
 * ## Authorization is not `card:update`
 *
 * Commenting is `comment:create`, and that separation is the whole reason the
 * `commenter` relation exists (§8.2): a person can be given the ability to
 * discuss a board without the ability to change anything on it. Using
 * `card:update` here would collapse those two into one, and the restrictive
 * `commenter` tuple would grant nothing it was meant to.
 *
 * ## Editing and deleting are asymmetric on purpose
 *
 * Only the AUTHOR may edit a comment — there is no permission that lets someone
 * rewrite another person's words, because a discussion where that is possible
 * is not evidence of anything. Deleting is different: an author may withdraw
 * their own comment, and a moderator holding `comment:delete` may remove
 * someone else's. The event records which of the two happened, because
 * "moderator removed a comment" is the interesting entry in an audit log and
 * "author deleted their own typo" is not.
 *
 * Deletion is a tombstone rather than a row removal, so a thread does not
 * silently lose its middle and become incoherent.
 */

export interface CommentSummary {
  readonly commentId: string;
  readonly cardId: string;
  /** Null for a top-level comment, the parent's id for a reply — one level only. */
  readonly parentCommentId: string | null;
  readonly authorId: string | null;
  readonly body: unknown;
  readonly bodyText: string;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * A card's comment thread, oldest first.
 *
 * Ordered by id, which IS creation order because ids are UUIDv7 (§7.1) —
 * and unlike `created_at`, it is unique, so the order is total.
 */
export async function listComments(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly CommentSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const rows = await tx
      .select({
        commentId: schema.cardComments.id,
        cardId: schema.cardComments.cardId,
        parentCommentId: schema.cardComments.parentCommentId,
        authorId: schema.cardComments.authorId,
        body: schema.cardComments.body,
        bodyText: schema.cardComments.bodyText,
        editedAt: schema.cardComments.editedAt,
        deletedAt: schema.cardComments.deletedAt,
        createdAt: schema.cardComments.createdAt,
      })
      .from(schema.cardComments)
      .where(eq(schema.cardComments.cardId, input.cardId))
      .orderBy(asc(schema.cardComments.id));

    /* A deleted comment keeps its place and loses its content. Returning the
       body of a deleted comment would make "delete" mean "hide in the UI",
       which is not what the person clicking it believes. */
    return rows.map((row) =>
      row.deletedAt === null ? row : { ...row, body: null, bodyText: '', authorId: row.authorId },
    );
  });
}

export async function createComment(
  actor: WorkActor,
  input: {
    readonly cardId: CardId;
    readonly body: RichTextNode;
    /** Null (or omitted) for a top-level comment; a comment's id to reply to it. */
    readonly parentCommentId?: CommentId | null;
  },
): Promise<{ readonly commentId: CommentId }> {
  const commentId = newId<'CommentId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);

    // `comment:create`, not `card:update` — see the note at the top.
    enforceOn(
      actor,
      'comment:create',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    /* Replies are ONE level deep — the migration's composite FK stops a reply
       naming a parent from another card, but says nothing about depth, which
       is a product rule rather than a relational one (0013's migration
       comment). A parent that is itself a reply, or belongs to a different
       card, or was deleted, is all the same answer: this cannot be replied
       to. `errors.notFound()` for the cross-card case specifically — a
       parent id from another card is indistinguishable from a made-up one to
       whoever is calling this. */
    if (input.parentCommentId != null) {
      const parent = await loadComment(tx, input.parentCommentId);
      if (parent.cardId !== input.cardId) throw errors.notFound();
      if (parent.deletedAt !== null) throw errors.notFound();
      if (parent.parentCommentId !== null) {
        throw errors.validation({ parentCommentId: 'Replies cannot themselves be replied to.' });
      }
    }

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      // A document that renders to nothing is an empty comment with structure.
      // Storing it produces a thread entry nobody can see and a notification
      // about nothing.
      throw errors.validation({ body: 'A comment cannot be empty.' });
    }

    await tx.insert(schema.cardComments).values({
      id: commentId,
      orgId,
      cardId: input.cardId,
      parentCommentId: input.parentCommentId ?? null,
      authorId: actor.subject.userId,
      body: input.body,
      bodyText,
    });

    await recountComments(tx, input.cardId);

    await outboxWriter.append(tx, [
      createEvent(
        commentCreated,
        {
          commentId,
          cardId: input.cardId,
          boardId: card.boardId,
          // Words, not a document: a notification cannot render TipTap JSON.
          excerpt: bodyText.slice(0, 280),
          parentCommentId: input.parentCommentId ?? null,
          mentionedUserIds: mentionedUserIds(input.body),
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { commentId };
}

/**
 * Edits a comment. Author only.
 *
 * There is deliberately no permission that overrides this. A moderator can
 * DELETE someone's comment but cannot rewrite it — a discussion where an
 * administrator can put words in your mouth is not a record of anything, and no
 * product requirement is worth that.
 */
export async function updateComment(
  actor: WorkActor,
  input: { readonly commentId: CommentId; readonly body: RichTextNode },
): Promise<{ readonly edited: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const comment = await loadComment(tx, input.commentId);
    const card = await loadCard(tx, comment.cardId as CardId);

    enforceOn(
      actor,
      'comment:create',
      { type: 'card', id: comment.cardId },
      card,
      ancestorsOfCard(card),
    );

    if (comment.deletedAt !== null) throw errors.notFound();

    /* Not a permission check — an identity check. Comparing the author to the
       caller is not a role comparison, so guardrail 7 has nothing to say about
       it, and there is no permission that could express "your own". */
    if (comment.authorId !== actor.subject.userId) {
      throw errors.forbidden('You can only edit your own comments.');
    }

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      throw errors.validation({ body: 'A comment cannot be empty.' });
    }

    await tx
      .update(schema.cardComments)
      .set({ body: input.body, bodyText, editedAt: new Date() })
      .where(eq(schema.cardComments.id, input.commentId));

    await outboxWriter.append(tx, [
      createEvent(
        commentUpdated,
        { commentId: input.commentId, cardId: comment.cardId, boardId: card.boardId },
        envelopeOf(actor),
      ),
    ]);

    return { edited: true as const };
  });
}

/**
 * Deletes a comment — the author's own, or anyone's with `comment:delete`.
 *
 * A tombstone, not a row removal: the thread keeps its shape, and a reply that
 * quotes the deleted comment still has something to point at.
 */
export async function deleteComment(
  actor: WorkActor,
  input: { readonly commentId: CommentId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const comment = await loadComment(tx, input.commentId);
    const card = await loadCard(tx, comment.cardId as CardId);

    if (comment.deletedAt !== null) throw errors.notFound();

    const byAuthor = comment.authorId === actor.subject.userId;

    /* An author withdrawing their own comment needs only the ability to
       comment; removing someone else's is a moderation action and needs the
       moderation permission. `enforce` answers 404 rather than 403 when the
       caller cannot even read cards here, so this does not confirm the comment
       exists to someone with no access. */
    enforceOn(
      actor,
      byAuthor ? 'comment:create' : 'comment:delete',
      { type: 'card', id: comment.cardId },
      card,
      ancestorsOfCard(card),
    );

    await tx
      .update(schema.cardComments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.cardComments.id, input.commentId));

    await recountComments(tx, comment.cardId as CardId);

    await outboxWriter.append(tx, [
      createEvent(
        commentDeleted,
        {
          commentId: input.commentId,
          cardId: comment.cardId,
          boardId: card.boardId,
          byAuthor,
        },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

interface CommentRow {
  readonly orgId: string;
  readonly cardId: string;
  readonly parentCommentId: string | null;
  readonly authorId: string | null;
  readonly deletedAt: Date | null;
}

async function loadComment(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  commentId: CommentId,
): Promise<CommentRow> {
  const rows = await tx
    .select({
      orgId: schema.cardComments.orgId,
      cardId: schema.cardComments.cardId,
      parentCommentId: schema.cardComments.parentCommentId,
      authorId: schema.cardComments.authorId,
      deletedAt: schema.cardComments.deletedAt,
    })
    .from(schema.cardComments)
    .where(eq(schema.cardComments.id, commentId))
    .limit(1);

  const comment = rows[0];
  if (!comment) throw errors.notFound();
  return comment;
}
