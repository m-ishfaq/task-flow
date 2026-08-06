import { and, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type AttachmentId, type ChannelId, type MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { isAcceptedContentType } from '@taskflow/security';
import { newId } from '@taskflow/security';
import { newStorageKey } from '@taskflow/storage';
import { verifyUpload, type VerifyDeps } from '../attachments/verify.js';
import { claimForScanning } from '../work/attachment-status.js';
import {
  messageAttachmentsChanged,
  messageAttachmentDeleted,
  messageAttachmentDownloaded,
  messageAttachmentPresigned,
  messageAttachmentRejected,
  messageAttachmentUploaded,
} from './events.js';
import {
  enforceOnChannel,
  envelopeOf,
  loadChannel,
  loadMessageRow,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';

/**
 * Message attachments (Wave 3, ai/phase-5-chat.md §3.10).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): a file upload/download path.
 *
 * ## This is the existing pipeline pointed at a channel, not a second one
 *
 * §3.10 is explicit: chat file sharing is `packages/storage` + magic bytes +
 * ClamAV aimed at a `channelId` instead of a `cardId`. The VERDICT — key shape,
 * size, magic bytes, virus scan, and the fail-closed handling of a scanner that
 * could not answer — is `attachments/verify.ts`, shared with Work. What differs
 * here is only who may do it and which event is written.
 *
 * ## The message exists before the file does
 *
 * You send the message, then attach to it. That ordering is not a UX
 * preference, it is what makes authorization answerable: an attachment's parent
 * is a message, a message's channel decides who may read it, and until the
 * message exists there is nothing to check `channel:read` against. The
 * alternative — reserving an id for a message nobody has written — leaves rows
 * in `platform.attachments` whose parent may never exist and which no
 * authorization query can reach.
 *
 * ## The one invariant, restated because it is the whole slice
 *
 * `presignDownload` is called for exactly one kind of row: `status = 'clean'`.
 * The object exists in storage the moment the browser's PUT finishes and
 * nothing here can prevent that. What this service controls is whether anyone
 * is ever handed a URL to it.
 */

export interface MessageAttachmentSummary {
  readonly attachmentId: string;
  readonly messageId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly status: string;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
}

/** Step 1 — reserve a row against an existing message and issue a presigned PUT. */
export async function presignUpload(
  actor: ChatActor,
  deps: VerifyDeps,
  input: {
    readonly messageId: MessageId;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  },
): Promise<{
  readonly attachmentId: AttachmentId;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}> {
  /* Checked here as well as at the route boundary, because this is the value
     pinned into the SIGNATURE — an unlisted type would then be stored under a
     signature saying it was fine. */
  if (!isAcceptedContentType(input.contentType)) {
    throw errors.validation({ contentType: 'That file type is not accepted.' });
  }
  if (input.sizeBytes > deps.maxBytes) {
    throw errors.validation({
      sizeBytes: `Files must be ${String(deps.maxBytes)} bytes or smaller.`,
    });
  }

  const attachmentId = newId<'AttachmentId'>();
  const orgId = orgOf(actor);
  // Server-generated. Nothing from the client reaches the key.
  const storageKey = newStorageKey(orgId);

  const channelId = await withOrgScope(orgId, async (tx) => {
    const message = await loadMessageRow(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    enforceOnChannel(actor, 'attachment:upload', channel);

    /* Author only. Attaching a file to somebody else's message would put your
       bytes under their name — the same reasoning that makes message EDITING
       author-only with no permission override. A moderator who wants a file in
       the channel posts their own message. */
    if (message.authorId !== userOf(actor)) {
      throw errors.forbidden('You can only attach files to your own messages.');
    }
    if (message.deletedAt !== null) throw errors.notFound();

    await tx.insert(schema.attachments).values({
      id: attachmentId,
      orgId,
      parentType: 'message',
      parentId: input.messageId,
      storageKey,
      filename: input.filename,
      contentType: input.contentType,
      declaredBytes: input.sizeBytes,
      uploadedBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(
        messageAttachmentPresigned,
        {
          attachmentId,
          channelId: message.channelId,
          messageId: input.messageId,
          filename: input.filename,
          contentType: input.contentType,
          declaredBytes: input.sizeBytes,
        },
        envelopeOf(actor),
      ),
    ]);

    return message.channelId;
  });

  /* After the transaction commits: presigning is a network round trip to
     storage and must not hold a database connection on the upload path. */
  const presigned = await deps.storage.presignUpload({
    key: storageKey,
    contentType: input.contentType,
    maxBytes: input.sizeBytes,
  });

  void channelId;

  return {
    attachmentId,
    url: presigned.url,
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
  };
}

export interface ConfirmResult {
  readonly status: 'clean' | 'infected' | 'rejected';
  readonly reason?: string;
}

/** Step 2 — verify what actually landed, then scan it. */
export async function confirmUpload(
  actor: ChatActor,
  deps: VerifyDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<ConfirmResult> {
  const orgId = orgOf(actor);

  const row = await withOrgScope(orgId, async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const message = await loadMessageRow(tx, attachment.parentId as MessageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    enforceOnChannel(actor, 'attachment:upload', channel);

    /* A conditional claim, not a check-then-write. Two confirms racing on one
       attachment — a double-clicked button, a client retry — would otherwise
       both read `pending`, both scan, and both write a verdict, including
       overwriting `infected` with `clean`. Exactly one caller wins. */
    if (!(await claimForScanning(tx, input.attachmentId))) {
      throw errors.conflict('This upload has already been confirmed.');
    }

    return { ...attachment, channelId: message.channelId };
  });

  const verdict = await verifyUpload(deps, {
    storageKey: row.storageKey,
    contentType: row.contentType,
  });

  return settle(actor, deps, row, verdict.status, verdict.reason, verdict.sizeBytes);
}

/**
 * Writes the terminal status, deletes the object when it is not clean, and
 * emits the matching event.
 *
 * The delete matters: an infected or mismatched file has no reason to remain in
 * storage, and leaving it there means a bucket slowly fills with exactly the
 * objects nobody wants to find during an incident.
 */
async function settle(
  actor: ChatActor,
  deps: VerifyDeps,
  row: AttachmentRow & { readonly channelId: string },
  status: 'clean' | 'infected' | 'rejected',
  reason?: string,
  sizeBytes?: number,
): Promise<ConfirmResult> {
  if (status !== 'clean') {
    // Best effort. A failure to delete must not stop the row being marked
    // unusable, which is the part that protects anyone.
    await deps.storage.delete(row.storageKey).catch(() => undefined);
  }

  await withOrgScope(orgOf(actor), async (tx) => {
    await tx
      .update(schema.attachments)
      .set({
        status,
        scanResult: reason ?? null,
        scannedAt: new Date(),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        updatedAt: new Date(),
      })
      .where(eq(schema.attachments.id, row.id));

    await outboxWriter.append(tx, [
      status === 'clean'
        ? createEvent(
            messageAttachmentUploaded,
            {
              attachmentId: row.id,
              channelId: row.channelId,
              messageId: row.parentId,
              filename: row.filename,
              contentType: row.contentType,
              sizeBytes: sizeBytes ?? 0,
            },
            envelopeOf(actor),
          )
        : createEvent(
            messageAttachmentRejected,
            {
              attachmentId: row.id,
              channelId: row.channelId,
              messageId: row.parentId,
              filename: row.filename,
              status,
              reason: reason ?? 'Rejected.',
            },
            envelopeOf(actor),
          ),
    ]);

    /* Only on 'clean'. A rejected or infected upload is not something the
       channel needs to refetch for — there is nothing downloadable to show,
       and telling the room a file was refused would broadcast the fact that
       somebody uploaded malware to everyone watching. */
    if (status === 'clean') {
      await outboxWriter.append(tx, [
        createEvent(
          messageAttachmentsChanged,
          { messageId: row.parentId, channelId: row.channelId },
          envelopeOf(actor),
        ),
      ]);
    }
  });

  return reason === undefined ? { status } : { status, reason };
}

/**
 * Step 3 — a short-lived download URL, issued after a fresh authorization check.
 *
 * The URL carries no identity: anyone holding it can fetch the object until it
 * expires. So the check happens immediately before it is minted, the TTL is 60
 * seconds (§8.4), and every issue is audited — a download is an access to data,
 * and "who took a copy" is a question the audit log has to be able to answer.
 *
 * This is also why an attachment id is never broadcast with a URL attached
 * (§3.10): a room's audience is everyone subscribed, and this check is per
 * caller.
 */
export async function presignDownload(
  actor: ChatActor,
  deps: VerifyDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<{ readonly url: string; readonly filename: string; readonly expiresInSeconds: number }> {
  const expiresInSeconds = 60;

  const row = await withOrgScope(orgOf(actor), async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const message = await loadMessageRow(tx, attachment.parentId as MessageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    enforceOnChannel(actor, 'attachment:download', channel);

    /* THE invariant. Anything that is not `clean` has either not been checked
       or has been checked and failed, and in both cases there is nothing to
       hand out. 404 rather than 403 — the caller does not need to learn that a
       file exists and is infected. */
    if (attachment.status !== 'clean') throw errors.notFound();

    await outboxWriter.append(tx, [
      createEvent(
        messageAttachmentDownloaded,
        {
          attachmentId: attachment.id,
          channelId: message.channelId,
          messageId: attachment.parentId,
          filename: attachment.filename,
        },
        envelopeOf(actor),
      ),
    ]);

    return attachment;
  });

  const url = await deps.storage.presignDownload(row.storageKey, expiresInSeconds);
  return { url, filename: row.filename, expiresInSeconds };
}

/** Every live attachment on the named messages, for rendering a page of them. */
export async function listForMessages(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageIds: readonly MessageId[] },
): Promise<readonly MessageAttachmentSummary[]> {
  if (input.messageIds.length === 0) return [];

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const rows = await tx
      .select({
        attachmentId: schema.attachments.id,
        messageId: schema.attachments.parentId,
        filename: schema.attachments.filename,
        contentType: schema.attachments.contentType,
        sizeBytes: schema.attachments.sizeBytes,
        status: schema.attachments.status,
        uploadedBy: schema.attachments.uploadedBy,
        createdAt: schema.attachments.createdAt,
      })
      .from(schema.attachments)
      .where(
        and(eq(schema.attachments.parentType, 'message'), isNull(schema.attachments.deletedAt)),
      )
      .orderBy(schema.attachments.createdAt);

    /* Filtered in memory rather than with an IN clause on `messageIds`: the
       caller passes the page it has already loaded, and every row here is
       already confined to this org by RLS and to this channel by the
       `channel:read` check above. */
    const wanted = new Set<string>(input.messageIds);
    return rows.filter((row) => wanted.has(row.messageId));
  });
}

/**
 * Removes an attachment.
 *
 * Soft-deletes the row and deletes the object. The row survives so the audit
 * trail still has something to name; the bytes do not, because "delete" should
 * mean the file is gone rather than hidden.
 *
 * Author-or-moderator, matching message deletion: you may withdraw your own
 * file, and someone holding `message:delete` may remove anyone's.
 */
export async function deleteAttachment(
  actor: ChatActor,
  deps: VerifyDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<{ readonly deleted: true }> {
  const row = await withOrgScope(orgOf(actor), async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const message = await loadMessageRow(tx, attachment.parentId as MessageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    const byAuthor = attachment.uploadedBy === userOf(actor);
    enforceOnChannel(actor, byAuthor ? 'message:create' : 'message:delete', channel);

    await tx
      .update(schema.attachments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.attachments.id, input.attachmentId));

    await outboxWriter.append(tx, [
      createEvent(
        messageAttachmentDeleted,
        {
          attachmentId: attachment.id,
          channelId: message.channelId,
          messageId: attachment.parentId,
          filename: attachment.filename,
        },
        envelopeOf(actor),
      ),
      createEvent(
        messageAttachmentsChanged,
        { messageId: attachment.parentId, channelId: message.channelId },
        envelopeOf(actor),
      ),
    ]);

    return attachment;
  });

  await deps.storage.delete(row.storageKey).catch(() => undefined);
  return { deleted: true as const };
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

type ChatTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

interface AttachmentRow {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly status: string;
  readonly uploadedBy: string | null;
}

async function loadAttachment(tx: ChatTx, attachmentId: AttachmentId): Promise<AttachmentRow> {
  const rows = await tx
    .select({
      id: schema.attachments.id,
      orgId: schema.attachments.orgId,
      parentId: schema.attachments.parentId,
      storageKey: schema.attachments.storageKey,
      filename: schema.attachments.filename,
      contentType: schema.attachments.contentType,
      status: schema.attachments.status,
      uploadedBy: schema.attachments.uploadedBy,
    })
    .from(schema.attachments)
    .where(
      and(
        eq(schema.attachments.id, attachmentId),
        /* Scoped to message attachments. Without this, a chat route handed a
           CARD attachment's id would authorize it against a channel — and the
           parent id would be a card id, which `loadMessageRow` answers 404 for
           only by luck. Making the type part of the lookup means the wrong
           parent kind is not found rather than mis-authorized. */
        eq(schema.attachments.parentType, 'message'),
        isNull(schema.attachments.deletedAt),
      ),
    )
    .limit(1);

  const attachment = rows[0];
  if (!attachment) throw errors.notFound();
  return attachment;
}
