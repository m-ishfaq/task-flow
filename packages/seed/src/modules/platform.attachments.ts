import { createEvent } from '@taskflow/events';
import { attachmentUploaded } from '@taskflow/api/events/work';
import { messageAttachmentUploaded } from '@taskflow/api/events/chat';
import { newStorageKey } from '@taskflow/storage';
import type { StorageProvider } from '@taskflow/contracts';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { cardsModule } from './work.cards.js';
import { messagesModule } from './chat.messages.js';

/**
 * Attachments — the one child table that is a LIE if seeded as a bare row.
 *
 * CLAUDE.md is explicit: "a row marked clean whose object doesn't exist
 * yields a presigned URL that 404s." So this module either uploads a real
 * object through the same presigned-PUT path a browser uses, or it writes
 * nothing at all — there is no third option where a plausible-looking row is
 * inserted without bytes behind it.
 *
 * `ctx.storage` being null (STORAGE_* unset, or `--profile large`, which
 * turns attachments off entirely) is not an error here. It is the signal to
 * skip cleanly rather than fabricate.
 *
 * ## Cards and messages, one pipeline
 *
 * `platform.attachments` is polymorphic — `(parent_type, parent_id)`, with
 * `'message'` in migration 0010's CHECK from the start — so a chat upload is
 * the same row with a different parent and needs no table of its own. Both
 * parents are seeded here rather than chat seeding its own, because the rule
 * this module exists to enforce is about STORAGE, not about which product asked:
 * a second module uploading files would be a second place for "write the row
 * only if the bytes landed" to be got wrong, and the copy without the argument
 * in front of it is the one that would drift.
 *
 * The events differ and cannot be shared: Work's `attachment.uploaded` requires
 * `cardId` and `boardId`, which a chat upload has neither of, so chat has its
 * own `message_attachment.*` family. ⚠ Those names must never reach
 * `apps/realtime`'s event→room table — a presigned download URL is a bearer
 * credential and a channel room's audience is everyone subscribed. The boot-time
 * assertion in `event-rooms.ts` matches "attachment" anywhere in the resource
 * segment specifically so this prefix is caught, and seeding these puts real
 * rows in the outbox for that exclusion to act on.
 */

/**
 * A 1x1 transparent PNG (67 bytes) — a real, valid object rather than a
 * placeholder blob. Small enough that ~110 of them upload in seconds, and
 * genuinely a PNG: if the real confirm pipeline ever ran against a seeded
 * key, `verifyMagicBytes` would accept it exactly as it would a real screenshot.
 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const FILENAMES = [
  'screenshot.png',
  'diagram.png',
  'mockup.png',
  'before.png',
  'after.png',
] as const;

export interface AttachmentsOutput {
  readonly attachmentCount: number;
}

const CONTENT_TYPE = 'image/png';

/**
 * Places the bytes and returns the row, or throws.
 *
 * The real client-side path, not a shortcut: PUT at the signed URL exactly as a
 * browser would. Anything else would leave `signableHeaders`
 * (`packages/storage/src/s3.ts`) unexercised for the one write path in this
 * whole package that uses it — and that option is the difference between the
 * MIME type being pinned in the signature and merely being written on the
 * command.
 */
async function uploadObject(
  storage: StorageProvider,
  bytes: Buffer,
  orgId: string,
  createdAt: Date,
): Promise<string> {
  const storageKey = newStorageKey(orgId, createdAt);

  const presigned = await storage.presignUpload({
    key: storageKey,
    contentType: CONTENT_TYPE,
    maxBytes: bytes.length,
  });

  const response = await fetch(presigned.url, {
    method: 'PUT',
    headers: presigned.headers,
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(
      `platform.attachments: upload to storage failed (HTTP ${String(response.status)}) ` +
        `for ${storageKey}. Is MinIO running (docker compose up -d)?`,
    );
  }

  return storageKey;
}

export const attachmentsModule = defineSeedModule({
  name: 'platform.attachments',
  requires: [cardsModule, messagesModule],
  tables: ['platform.attachments'],

  async seed(ctx): Promise<AttachmentsOutput> {
    if (!ctx.profile.attachments) {
      ctx.log('platform.attachments: skipped — this profile does not seed attachments.');
      return { attachmentCount: 0 };
    }
    if (!ctx.storage) {
      ctx.log('platform.attachments: skipped — no storage configured (set STORAGE_* env vars).');
      return { attachmentCount: 0 };
    }
    const storage = ctx.storage;

    const rng = ctx.rng.fork('platform.attachments');
    const { cardRefs } = ctx.use(cardsModule);
    const { messageRefs } = ctx.use(messagesModule);
    const bytes = Buffer.from(PNG_BASE64, 'base64');

    const rowsByOrg = new Map<string, unknown[][]>();
    let attachmentCount = 0;

    /**
     * One attachment row, shaped exactly as the confirm pipeline would leave it.
     *
     * `clean` is the only status seeded, deliberately. The whole security
     * argument of this pipeline is that `presignDownload` is reachable for
     * exactly one status, so an `infected` or `rejected` row would be an object
     * in storage that nothing will ever hand out a URL to — a fixture whose only
     * observable behaviour is absence.
     */
    const record = (input: {
      readonly attachmentId: string;
      readonly orgId: string;
      readonly parentType: 'card' | 'message';
      readonly parentId: string;
      readonly storageKey: string;
      readonly filename: string;
      readonly uploadedBy: string;
      readonly scannedAt: Date;
    }): void => {
      const rows = rowsByOrg.get(input.orgId) ?? [];
      rows.push([
        input.attachmentId,
        input.orgId,
        input.parentType,
        input.parentId,
        input.storageKey,
        input.filename,
        CONTENT_TYPE,
        bytes.length,
        bytes.length,
        'clean',
        null,
        input.scannedAt,
        input.uploadedBy,
        input.scannedAt,
        input.scannedAt,
        null,
      ]);
      rowsByOrg.set(input.orgId, rows);
      attachmentCount += 1;
    };

    for (const ref of cardRefs) {
      if (!rng.chance(ctx.profile.card.attachmentRate)) continue;

      const filename = rng.pick(FILENAMES);
      const storageKey = await uploadObject(storage, bytes, ref.orgId, ref.createdAt);
      const scannedAt = minutesAfter(ref.createdAt, 1);
      const attachmentId = rng.uuid(ctx.now);

      record({
        attachmentId,
        orgId: ref.orgId,
        parentType: 'card',
        parentId: ref.id,
        storageKey,
        filename,
        uploadedBy: ref.createdBy,
        scannedAt,
      });

      ctx.emit(
        createEvent(
          attachmentUploaded,
          {
            attachmentId,
            cardId: ref.id,
            boardId: ref.boardId,
            filename,
            contentType: CONTENT_TYPE,
            sizeBytes: bytes.length,
          },
          envelopeFor(ref.orgId, ref.createdBy, scannedAt),
        ),
      );
    }

    /* Message attachments. Uploaded by the message's AUTHOR — an attachment on
       someone else's message is not a state the chat route can produce, since
       `presignMessageUpload` attaches to a draft the caller is composing. */
    for (const ref of messageRefs) {
      if (!rng.chance(ctx.profile.message.attachmentRate)) continue;

      const filename = rng.pick(FILENAMES);
      const storageKey = await uploadObject(storage, bytes, ref.orgId, ref.createdAt);
      const scannedAt = minutesAfter(ref.createdAt, 1);
      const attachmentId = rng.uuid(ctx.now);

      record({
        attachmentId,
        orgId: ref.orgId,
        parentType: 'message',
        parentId: ref.id,
        storageKey,
        filename,
        uploadedBy: ref.authorId,
        scannedAt,
      });

      ctx.emit(
        createEvent(
          messageAttachmentUploaded,
          {
            attachmentId,
            channelId: ref.channelId,
            messageId: ref.id,
            filename,
            contentType: CONTENT_TYPE,
            sizeBytes: bytes.length,
          },
          envelopeFor(ref.orgId, ref.authorId, scannedAt),
        ),
      );
    }

    for (const [orgId, rows] of rowsByOrg) {
      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'platform.attachments',
          [
            'id',
            'org_id',
            'parent_type',
            'parent_id',
            'storage_key',
            'filename',
            'content_type',
            'declared_bytes',
            'size_bytes',
            'status',
            'scan_result',
            'scanned_at',
            'uploaded_by',
            'created_at',
            'updated_at',
            'deleted_at',
          ],
          rows,
        );
      });
    }

    ctx.log(`platform.attachments: ${String(attachmentCount)} uploaded and marked clean`);
    return { attachmentCount };
  },
});
