import { createEvent } from '@taskflow/events';
import { attachmentUploaded } from '@taskflow/api/events/work';
import { newStorageKey } from '@taskflow/storage';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { cardsModule } from './work.cards.js';

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

export const attachmentsModule = defineSeedModule({
  name: 'platform.attachments',
  requires: [cardsModule],
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
    const bytes = Buffer.from(PNG_BASE64, 'base64');
    const contentType = 'image/png';

    const rowsByOrg = new Map<string, unknown[][]>();
    let attachmentCount = 0;

    for (const ref of cardRefs) {
      if (!rng.chance(ctx.profile.card.attachmentRate)) continue;

      const attachmentId = rng.uuid(ctx.now);
      const storageKey = newStorageKey(ref.orgId, ref.createdAt);
      const filename = rng.pick(FILENAMES);

      const presigned = await storage.presignUpload({
        key: storageKey,
        contentType,
        maxBytes: bytes.length,
      });

      /* The real client-side path, not a shortcut: PUT the bytes at the
         signed URL, exactly as a browser would. Anything else would leave
         `signableHeaders` (packages/storage/src/s3.ts) unexercised for the
         one write path in this whole package that actually uses it. */
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

      const scannedAt = minutesAfter(ref.createdAt, 1);
      const rows = rowsByOrg.get(ref.orgId) ?? [];
      rows.push([
        attachmentId,
        ref.orgId,
        'card',
        ref.id,
        storageKey,
        filename,
        contentType,
        bytes.length,
        bytes.length,
        'clean',
        null,
        scannedAt,
        ref.createdBy,
        scannedAt,
        scannedAt,
        null,
      ]);
      rowsByOrg.set(ref.orgId, rows);

      ctx.emit(
        createEvent(
          attachmentUploaded,
          {
            attachmentId,
            cardId: ref.id,
            boardId: ref.boardId,
            filename,
            contentType,
            sizeBytes: bytes.length,
          },
          envelopeFor(ref.orgId, ref.createdBy, scannedAt),
        ),
      );

      attachmentCount += 1;
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
