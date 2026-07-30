import { and, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type AttachmentId, type CardId, type StorageProvider } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  MAGIC_BYTE_PREFIX_LENGTH,
  isAcceptedContentType,
  scanBuffer,
  verifyMagicBytes,
  type ScannerConfig,
} from '@taskflow/security';
import { isGeneratedKey, newStorageKey, readAll, readPrefix } from '@taskflow/storage';
import {
  attachmentDeleted,
  attachmentRejected,
  attachmentUploaded,
  attachmentDownloaded,
  attachmentPresigned,
} from './events.js';
import { claimForScanning } from './attachment-status.js';
import { loadCard } from './card.service.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, type WorkActor } from './shared.js';

/**
 * Attachments — the upload pipeline from PLAN.md §8.4.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): file upload and download paths.
 *
 *     presign  ->  browser PUTs directly to storage
 *              ->  confirm: HEAD, magic bytes, virus scan
 *              ->  status = 'clean'  ->  downloadable
 *
 * ## The one invariant
 *
 * `presignDownload` is called for exactly one kind of row: `status = 'clean'`.
 * The object exists in storage from the moment the browser's PUT finishes —
 * nothing here can prevent that — so what this service controls is whether
 * anyone is ever handed a URL to it. Every other rule in this file exists to
 * make that one decision correct.
 *
 * ## Why confirm is a separate call
 *
 * The API never sees the bytes, so it cannot check them during the upload. The
 * client tells us the PUT finished, and only then do we look: HEAD to learn
 * what actually landed, the first 64 bytes to check the type is not a lie, and
 * the whole object to scan. A client that never calls confirm leaves a
 * `pending` row and an orphaned object, which a retention job collects — it
 * does not leave a downloadable file nobody checked.
 *
 * ## Fail closed at every step
 *
 * A missing object, a type mismatch, a scanner that is down, a scanner reply
 * nobody recognizes — all of them end at a status that is not `clean`. The
 * scanner being unreachable is the important one: treating "we could not check"
 * as "clean" would turn an outage into an unscanned-upload window, and uploads
 * would keep working perfectly the whole time.
 */

export interface AttachmentDeps {
  readonly storage: StorageProvider;
  readonly scanner: ScannerConfig;
  /** Largest upload accepted, in bytes. Also the ceiling on a server-side read. */
  readonly maxBytes: number;
}

export interface AttachmentSummary {
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly status: string;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
}

/**
 * Step 1 — reserve a row and issue a presigned PUT.
 *
 * The row is created BEFORE any bytes exist, at status `pending`. That ordering
 * is what makes an abandoned upload a collectable orphan rather than an
 * untracked object sitting in a bucket forever.
 */
export async function presignUpload(
  actor: WorkActor,
  deps: AttachmentDeps,
  input: {
    readonly cardId: CardId;
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
     that gets pinned into the signature — and an unlisted type would then be
     stored under a signature saying it was fine. */
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
  // Server-generated. Nothing from the client reaches the key — see
  // @taskflow/storage/keys for why that is the whole point.
  const storageKey = newStorageKey(orgId);

  await withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(
      actor,
      'attachment:upload',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    await tx.insert(schema.attachments).values({
      id: attachmentId,
      orgId,
      parentType: 'card',
      parentId: input.cardId,
      storageKey,
      filename: input.filename,
      contentType: input.contentType,
      declaredBytes: input.sizeBytes,
      uploadedBy: actor.subject.userId,
    });

    await outboxWriter.append(tx, [
      createEvent(
        attachmentPresigned,
        {
          attachmentId,
          cardId: input.cardId,
          boardId: card.boardId,
          filename: input.filename,
          contentType: input.contentType,
          declaredBytes: input.sizeBytes,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  /* Presigning happens AFTER the transaction commits. Doing it inside would
     hold a database connection open for a network round trip to storage, on
     the path every upload takes. */
  const presigned = await deps.storage.presignUpload({
    key: storageKey,
    contentType: input.contentType,
    maxBytes: input.sizeBytes,
  });

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

/**
 * Step 2 — verify what actually landed, then scan it.
 *
 * Runs entirely outside a transaction until the verdict is known, because it
 * makes several network calls to storage and to the scanner and none of them
 * should hold a database connection. The only write is the final status.
 */
export async function confirmUpload(
  actor: WorkActor,
  deps: AttachmentDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<ConfirmResult> {
  const orgId = orgOf(actor);

  const row = await withOrgScope(orgId, async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const card = await loadCard(tx, attachment.parentId as CardId);

    enforceOn(
      actor,
      'attachment:upload',
      { type: 'card', id: attachment.parentId },
      card,
      ancestorsOfCard(card),
    );

    /* A conditional claim, not a check-then-write. Two confirms racing on one
       attachment — a double-clicked button, a client retry — would otherwise
       both read `pending`, both scan, and both write a verdict. Exactly one
       caller wins the UPDATE; the loser is told it was already confirmed. */
    if (!(await claimForScanning(tx, input.attachmentId))) {
      throw errors.conflict('This upload has already been confirmed.');
    }

    return { ...attachment, boardId: card.boardId };
  });

  /* Backstop on a value that came from our own database. RLS already scoped the
     read, so this can only fire if a key reached a row from somewhere it should
     not have — which is exactly the case worth catching before handing it to
     the storage client. */
  if (!isGeneratedKey(row.storageKey)) {
    return settle(actor, deps, row, 'rejected', 'Storage key is not one this system generated.');
  }

  const metadata = await deps.storage.head(row.storageKey);
  if (!metadata) {
    return settle(actor, deps, row, 'rejected', 'No object was uploaded.');
  }
  if (metadata.size === 0) {
    return settle(actor, deps, row, 'rejected', 'The uploaded object is empty.');
  }
  if (metadata.size > deps.maxBytes) {
    return settle(actor, deps, row, 'rejected', 'The uploaded object is larger than allowed.');
  }

  /* Magic bytes. The presigned URL pinned Content-Type into the signature, so
     storage refused a body sent with a different HEADER — but that only proves
     the client said `image/png` twice, not that the bytes are a PNG. This is
     the step that closes that gap (§8.4). */
  const prefix = await readPrefix(deps.storage, row.storageKey, MAGIC_BYTE_PREFIX_LENGTH);
  const sniff = verifyMagicBytes(row.contentType, prefix);
  if (!sniff.ok) {
    return settle(actor, deps, row, 'rejected', sniff.reason ?? 'Contents do not match the type.');
  }

  const bytes = await readAll(deps.storage, row.storageKey, deps.maxBytes);
  const scan = await scanBuffer(bytes, deps.scanner);

  if (scan.verdict === 'infected') {
    return settle(actor, deps, row, 'infected', scan.detail ?? 'Malware detected.');
  }
  if (scan.verdict === 'error') {
    /* FAIL CLOSED. "We could not check" is not "clean" — treating it as clean
       turns a scanner outage into a window where unscanned files are
       downloadable, and nothing anywhere goes red. */
    return settle(actor, deps, row, 'rejected', `Scan failed: ${scan.detail ?? 'unknown error'}`);
  }

  return settle(actor, deps, { ...row, sizeBytes: metadata.size }, 'clean');
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
  actor: WorkActor,
  deps: AttachmentDeps,
  row: AttachmentRow & { readonly boardId: string; readonly sizeBytes?: number },
  status: 'clean' | 'infected' | 'rejected',
  reason?: string,
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
        ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
        updatedAt: new Date(),
      })
      .where(eq(schema.attachments.id, row.id));

    await outboxWriter.append(tx, [
      status === 'clean'
        ? createEvent(
            attachmentUploaded,
            {
              attachmentId: row.id,
              cardId: row.parentId,
              boardId: row.boardId,
              filename: row.filename,
              contentType: row.contentType,
              sizeBytes: row.sizeBytes ?? 0,
            },
            envelopeOf(actor),
          )
        : createEvent(
            attachmentRejected,
            {
              attachmentId: row.id,
              cardId: row.parentId,
              boardId: row.boardId,
              filename: row.filename,
              status,
              reason: reason ?? 'Rejected.',
            },
            envelopeOf(actor),
          ),
    ]);
  });

  return reason === undefined ? { status } : { status, reason };
}

/**
 * Step 3 — a short-lived download URL, issued after a fresh authorization check.
 *
 * The URL carries no identity: anyone holding it can fetch the object until it
 * expires. So the check happens immediately before it is minted, the TTL is 60
 * seconds (§8.4), and every issue is audited — a download of a file is an
 * access to data, and "who took a copy" is a question the audit log has to be
 * able to answer.
 */
export async function presignDownload(
  actor: WorkActor,
  deps: AttachmentDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<{ readonly url: string; readonly filename: string; readonly expiresInSeconds: number }> {
  const expiresInSeconds = 60;

  const row = await withOrgScope(orgOf(actor), async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const card = await loadCard(tx, attachment.parentId as CardId);

    enforceOn(
      actor,
      'attachment:download',
      { type: 'card', id: attachment.parentId },
      card,
      ancestorsOfCard(card),
    );

    /* THE invariant. Anything that is not `clean` has either not been checked
       or has been checked and failed, and in both cases there is nothing to
       hand out. 404 rather than 403 — the caller does not need to learn that a
       file exists and is infected. */
    if (attachment.status !== 'clean') throw errors.notFound();

    await outboxWriter.append(tx, [
      createEvent(
        attachmentDownloaded,
        {
          attachmentId: attachment.id,
          cardId: attachment.parentId,
          boardId: card.boardId,
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

export async function listAttachments(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly AttachmentSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    return tx
      .select({
        attachmentId: schema.attachments.id,
        filename: schema.attachments.filename,
        contentType: schema.attachments.contentType,
        sizeBytes: schema.attachments.sizeBytes,
        status: schema.attachments.status,
        uploadedBy: schema.attachments.uploadedBy,
        createdAt: schema.attachments.createdAt,
      })
      .from(schema.attachments)
      .where(
        and(
          eq(schema.attachments.parentType, 'card'),
          eq(schema.attachments.parentId, input.cardId),
          isNull(schema.attachments.deletedAt),
        ),
      )
      .orderBy(schema.attachments.createdAt);
  });
}

/**
 * Removes an attachment.
 *
 * Soft-deletes the row and deletes the object. The row survives so the audit
 * trail still has something to name; the bytes do not, because "delete" should
 * mean the file is gone rather than hidden.
 */
export async function deleteAttachment(
  actor: WorkActor,
  deps: AttachmentDeps,
  input: { readonly attachmentId: AttachmentId },
): Promise<{ readonly deleted: true }> {
  const row = await withOrgScope(orgOf(actor), async (tx) => {
    const attachment = await loadAttachment(tx, input.attachmentId);
    const card = await loadCard(tx, attachment.parentId as CardId);

    // Removing an attachment is editing the card it hangs off.
    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: attachment.parentId },
      card,
      ancestorsOfCard(card),
    );

    await tx
      .update(schema.attachments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.attachments.id, input.attachmentId));

    await outboxWriter.append(tx, [
      createEvent(
        attachmentDeleted,
        {
          attachmentId: attachment.id,
          cardId: attachment.parentId,
          boardId: card.boardId,
          filename: attachment.filename,
        },
        envelopeOf(actor),
      ),
    ]);

    return attachment;
  });

  await deps.storage.delete(row.storageKey).catch(() => undefined);
  return { deleted: true as const };
}

interface AttachmentRow {
  readonly id: string;
  readonly orgId: string;
  readonly parentId: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly status: string;
}

async function loadAttachment(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  attachmentId: AttachmentId,
): Promise<AttachmentRow> {
  const rows = await tx
    .select({
      id: schema.attachments.id,
      orgId: schema.attachments.orgId,
      parentId: schema.attachments.parentId,
      storageKey: schema.attachments.storageKey,
      filename: schema.attachments.filename,
      contentType: schema.attachments.contentType,
      status: schema.attachments.status,
    })
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, attachmentId), isNull(schema.attachments.deletedAt)))
    .limit(1);

  const attachment = rows[0];
  if (!attachment) throw errors.notFound();
  return attachment;
}
