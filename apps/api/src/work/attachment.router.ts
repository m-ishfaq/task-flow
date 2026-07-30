import { z } from 'zod';
import { AttachmentIdSchema, CardIdSchema } from '@taskflow/contracts';
import { ACCEPTED_CONTENT_TYPES } from '@taskflow/security';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { WorkActor } from './shared.js';
import * as attachments from './attachment.service.js';

/**
 * Attachment routes (PLAN.md §8.4).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): any file upload/download path.
 *
 * Three routes carry the pipeline, and the split between them is not
 * incidental — it is what lets the API check the bytes without ever receiving
 * them:
 *
 *   presign   reserve a row, hand back a signed PUT     `attachment:upload`
 *   confirm   HEAD, magic bytes, virus scan, verdict    `attachment:upload`
 *   download  fresh authorization, 60-second URL        `attachment:download`
 *
 * `download` is a MUTATION rather than a query, and that is deliberate: it
 * writes an audit event, and a query that writes is a query someone will
 * eventually cache, prefetch, or retry — each of which would corrupt the record
 * of who took a copy of a file.
 */

/**
 * A filename from a client.
 *
 * Bounded and stripped of path separators before it reaches the database, which
 * also enforces both. It never becomes part of a storage key — those are
 * server-generated — but it does reach `Content-Disposition` and a user's
 * filesystem on download.
 */
const Filename = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('/') && !value.includes('\\'), {
    message: 'A filename cannot contain a path separator.',
  })
  /* Control characters, checked by code point. A NUL truncates the name in any
     C-based consumer, and a newline reaching a Content-Disposition header is
     response splitting — both are invisible in a source literal, which is why
     this is a numeric comparison rather than a string that looks empty. */
  .refine(
    (value) => {
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) return false;
      }
      return true;
    },
    { message: 'A filename cannot contain control characters.' },
  );

export function createAttachmentRouter(deps: attachments.AttachmentDeps) {
  const actor = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: WorkActor['requestId'];
  }): WorkActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    list: route({ permission: 'card:read' })
      .input(z.object({ cardId: CardIdSchema }).strict())
      .output(
        z
          .array(
            z.object({
              attachmentId: z.string(),
              filename: z.string(),
              contentType: z.string(),
              sizeBytes: z.number().nullable(),
              status: z.string(),
              uploadedBy: z.string().nullable(),
              createdAt: z.date(),
            }),
          )
          .readonly(),
      )
      .query(({ input, ctx }) => attachments.listAttachments(actor(ctx), input)),

    /**
     * Step 1. Returns a URL the browser PUTs to directly.
     *
     * `contentType` is a closed enum rather than a string, and the list lives in
     * @taskflow/security next to the magic-byte table that has to agree with
     * it. A type accepted here and unknown there would be pinned into an upload
     * signature and then rejected on confirm — a file the user was told to
     * upload and then told was invalid.
     */
    presign: route({ permission: 'attachment:upload' })
      .input(
        z
          .object({
            cardId: CardIdSchema,
            filename: Filename,
            contentType: z.enum(ACCEPTED_CONTENT_TYPES as unknown as [string, ...string[]]),
            sizeBytes: z.number().int().positive(),
          })
          .strict(),
      )
      .output(
        z.object({
          attachmentId: z.string(),
          url: z.string(),
          headers: z.record(z.string()),
          expiresAt: z.date(),
        }),
      )
      .mutation(({ input, ctx }) => attachments.presignUpload(actor(ctx), deps, input)),

    /**
     * Step 2. The client says the PUT finished; the server checks what landed.
     *
     * Returns the verdict rather than throwing on rejection, because "your file
     * was refused, here is why" is a normal outcome of uploading and the client
     * needs to render it. An infected file and a mistyped one both arrive here
     * as a status, not an exception.
     */
    confirm: route({ permission: 'attachment:upload' })
      .input(z.object({ attachmentId: AttachmentIdSchema }).strict())
      .output(
        z.object({
          status: z.enum(['clean', 'infected', 'rejected']),
          reason: z.string().optional(),
        }),
      )
      .mutation(({ input, ctx }) => attachments.confirmUpload(actor(ctx), deps, input)),

    /**
     * Step 3. A 60-second URL, issued only for a row that scanned clean.
     *
     * A mutation because it writes the audit event §8.4 requires. The fetch
     * itself goes browser-to-storage and never touches this process, so the
     * issuing of the URL is the only moment that can be recorded.
     */
    download: route({ permission: 'attachment:download' })
      .input(z.object({ attachmentId: AttachmentIdSchema }).strict())
      .output(
        z.object({
          url: z.string(),
          filename: z.string(),
          expiresInSeconds: z.number().int().positive(),
        }),
      )
      .mutation(({ input, ctx }) => attachments.presignDownload(actor(ctx), deps, input)),

    /** Removing an attachment is editing the card it hangs off. */
    delete: route({ permission: 'card:update' })
      .input(z.object({ attachmentId: AttachmentIdSchema }).strict())
      .output(z.object({ deleted: z.literal(true) }))
      .mutation(({ input, ctx }) => attachments.deleteAttachment(actor(ctx), deps, input)),
  });
}
