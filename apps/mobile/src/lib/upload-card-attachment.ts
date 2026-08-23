import type { PickedFile } from './upload-message-file.js';

/**
 * The three-step upload for a Work card's attachments — the mobile
 * counterpart of `apps/web/src/features/work/detail/attachment-section.tsx`'s
 * own inline `upload` mutation, structured exactly like `upload-message-
 * file.ts`'s identical pipeline for Chat.
 *
 * A SEPARATE module from `upload-message-file.ts` rather than one shared
 * function, mirroring how `apps/web` itself keeps `AttachmentSection`
 * (Chat) and `AttachmentSection` (Work, this file's counterpart) as two
 * independent components rather than one generic uploader — CLAUDE.md §6:
 * extract a shared abstraction at the THIRD occurrence of a pattern, not
 * the second. The one real difference from the chat version: `presign`
 * here takes a `cardId` directly, with no `messageId`-style "send first"
 * step — a card, unlike a chat message, always already exists by the time
 * its detail screen can attach anything to it.
 *
 * Reuses `pick-attachment.ts`'s `PickedFile`/`pickAttachment()` unchanged
 * — the device-picker half has no chat- or work-specific coupling in it
 * at all.
 */

export interface UploadCardAttachmentDeps {
  readonly presign: (input: {
    readonly cardId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }) => Promise<{
    readonly attachmentId: string;
    readonly url: string;
    readonly headers: Record<string, string>;
  }>;
  readonly confirm: (input: {
    readonly attachmentId: string;
  }) => Promise<{ readonly status: 'clean' | 'infected' | 'rejected'; readonly reason?: string }>;
}

export async function uploadCardAttachment(
  deps: UploadCardAttachmentDeps,
  cardId: string,
  file: PickedFile,
  onProgress?: (stage: string) => void,
): Promise<{ readonly status: 'clean' | 'infected' | 'rejected'; readonly reason?: string }> {
  onProgress?.('Requesting an upload URL…');
  const presigned = await deps.presign({
    cardId,
    filename: file.name,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  });

  onProgress?.('Uploading…');
  const response = await fetch(presigned.url, {
    method: 'PUT',
    headers: presigned.headers,
    body: file.blob,
  });

  if (!response.ok) {
    throw new Error(
      `Storage refused the upload (${String(response.status)}). The file may not match the type or size that was signed.`,
    );
  }

  onProgress?.('Scanning…');
  return deps.confirm({ attachmentId: presigned.attachmentId });
}
