import { asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type CommentId, type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { decodeAnchor, encodeAnchor } from './anchor.js';
import {
  pageCommentCreated,
  pageCommentDeleted,
  pageCommentResolved,
  pageCommentUpdated,
} from './events.js';
import { flattenToText, type RichTextNode } from '../work/richtext.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, type DocsActor } from './shared.js';

/**
 * Page comments (ai/phase-6-docs.md §3.6, Wave 3).
 *
 * ## Authorization mirrors Work's card comments exactly
 *
 * `comment:create`, never `page:update` — CLAUDE.md's own precedent for Work
 * ("someone can be given a voice on a board without edit rights") applies
 * identically here: a `viewer`-tuple guest can read a page and comment on it
 * without holding `page:update`. Editing is author-only with no permission
 * override (an editable-by-a-moderator discussion is not a record of
 * anything); deleting is author-or-moderator, and the event records which.
 * `resolveComment` is the one addition Work's precedent does not have — see
 * its own doc comment for why it sits at `comment:create`'s tier rather than
 * a new permission.
 *
 * ## Anchors are opaque here too
 *
 * `anchor.ts`'s header explains the trust boundary; this file only ever
 * decodes an anchor to validate its SHAPE (`decodeAnchor`) before storing it,
 * and re-encodes it back to base64 on the way out (`encodeAnchor`). It never
 * inspects what a decoded anchor points at.
 */

export interface CommentSummary {
  readonly commentId: string;
  readonly pageId: string;
  readonly anchorFrom: string;
  readonly anchorTo: string;
  readonly authorId: string | null;
  readonly body: unknown;
  readonly bodyText: string;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

/** A page's comments, oldest first — id order, which is creation order (UUIDv7). */
export async function listComments(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<readonly CommentSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    const rows = await tx
      .select({
        commentId: schema.comments.id,
        pageId: schema.comments.pageId,
        anchorFrom: schema.comments.anchorFrom,
        anchorTo: schema.comments.anchorTo,
        authorId: schema.comments.authorId,
        body: schema.comments.body,
        bodyText: schema.comments.bodyText,
        resolvedAt: schema.comments.resolvedAt,
        resolvedBy: schema.comments.resolvedBy,
        editedAt: schema.comments.editedAt,
        deletedAt: schema.comments.deletedAt,
        createdAt: schema.comments.createdAt,
      })
      .from(schema.comments)
      .where(eq(schema.comments.pageId, input.pageId))
      .orderBy(asc(schema.comments.id));

    // A deleted comment keeps its place and loses its content — the same
    // convention Work's card comments follow, for the identical reason:
    // "delete" must mean delete, not "hide in the UI but still readable".
    return rows.map((row) => ({
      ...row,
      anchorFrom: encodeAnchor(row.anchorFrom),
      anchorTo: encodeAnchor(row.anchorTo),
      ...(row.deletedAt === null ? {} : { body: null, bodyText: '' }),
    }));
  });
}

export async function createComment(
  actor: DocsActor,
  input: {
    readonly pageId: PageId;
    readonly anchorFrom: string;
    readonly anchorTo: string;
    readonly body: RichTextNode;
  },
): Promise<{ readonly commentId: CommentId }> {
  const commentId = newId<'CommentId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'comment:create', page);

    const anchorFrom = decodeAnchor(input.anchorFrom);
    const anchorTo = decodeAnchor(input.anchorTo);

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      throw errors.validation({ body: 'A comment cannot be empty.' });
    }

    await tx.insert(schema.comments).values({
      id: commentId,
      orgId,
      pageId: input.pageId,
      anchorFrom,
      anchorTo,
      authorId: actor.subject.userId,
      body: input.body,
      bodyText,
    });

    await outboxWriter.append(tx, [
      createEvent(pageCommentCreated, { commentId, pageId: input.pageId }, envelopeOf(actor)),
    ]);
  });

  return { commentId };
}

/** Edits a comment. Author only — see the file header on why there is no override. */
export async function updateComment(
  actor: DocsActor,
  input: { readonly commentId: CommentId; readonly body: RichTextNode },
): Promise<{ readonly edited: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const comment = await loadComment(tx, input.commentId);
    const page = await loadPage(tx, comment.pageId as PageId);
    enforceOnPage(actor, 'comment:create', page);

    if (comment.deletedAt !== null) throw errors.notFound();

    // An identity check, not a role comparison — guardrail 7 has nothing to
    // say about it, and no permission could express "your own".
    if (comment.authorId !== actor.subject.userId) {
      throw errors.forbidden('You can only edit your own comments.');
    }

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      throw errors.validation({ body: 'A comment cannot be empty.' });
    }

    await tx
      .update(schema.comments)
      .set({ body: input.body, bodyText, editedAt: new Date() })
      .where(eq(schema.comments.id, input.commentId));

    await outboxWriter.append(tx, [
      createEvent(pageCommentUpdated, { commentId: input.commentId, pageId: comment.pageId }, envelopeOf(actor)),
    ]);

    return { edited: true as const };
  });
}

/**
 * Resolves or reopens a comment.
 *
 * Deliberately at `comment:create`'s tier, not `page:update`'s and not
 * author-only: resolving is "this discussion is handled", a housekeeping
 * fact about the THREAD, not an edit to the document or a claim only the
 * original author can make. Anyone who could comment can resolve, matching
 * how a shared document's comment thread works everywhere else this
 * product's users have seen one.
 */
export async function resolveComment(
  actor: DocsActor,
  input: { readonly commentId: CommentId; readonly resolved: boolean },
): Promise<{ readonly resolved: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const comment = await loadComment(tx, input.commentId);
    const page = await loadPage(tx, comment.pageId as PageId);
    enforceOnPage(actor, 'comment:create', page);

    if (comment.deletedAt !== null) throw errors.notFound();

    await tx
      .update(schema.comments)
      .set(
        input.resolved
          ? { resolvedAt: new Date(), resolvedBy: actor.subject.userId }
          : { resolvedAt: null, resolvedBy: null },
      )
      .where(eq(schema.comments.id, input.commentId));

    await outboxWriter.append(tx, [
      createEvent(
        pageCommentResolved,
        { commentId: input.commentId, pageId: comment.pageId, resolved: input.resolved },
        envelopeOf(actor),
      ),
    ]);

    return { resolved: input.resolved };
  });
}

/**
 * Deletes a comment — the author's own, or anyone's with `comment:delete`.
 * A tombstone, not a row removal, matching Work's card comments exactly.
 */
export async function deleteComment(
  actor: DocsActor,
  input: { readonly commentId: CommentId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const comment = await loadComment(tx, input.commentId);
    const page = await loadPage(tx, comment.pageId as PageId);

    if (comment.deletedAt !== null) throw errors.notFound();

    const byAuthor = comment.authorId === actor.subject.userId;
    enforceOnPage(actor, byAuthor ? 'comment:create' : 'comment:delete', page);

    await tx
      .update(schema.comments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.comments.id, input.commentId));

    await outboxWriter.append(tx, [
      createEvent(pageCommentDeleted, { commentId: input.commentId, pageId: comment.pageId }, envelopeOf(actor)),
    ]);

    return { deleted: true as const };
  });
}

interface CommentRow {
  readonly orgId: string;
  readonly pageId: string;
  readonly authorId: string | null;
  readonly deletedAt: Date | null;
}

async function loadComment(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  commentId: CommentId,
): Promise<CommentRow> {
  const rows = await tx
    .select({
      orgId: schema.comments.orgId,
      pageId: schema.comments.pageId,
      authorId: schema.comments.authorId,
      deletedAt: schema.comments.deletedAt,
    })
    .from(schema.comments)
    .where(eq(schema.comments.id, commentId))
    .limit(1);

  const comment = rows[0];
  if (!comment) throw errors.notFound();
  return comment;
}
