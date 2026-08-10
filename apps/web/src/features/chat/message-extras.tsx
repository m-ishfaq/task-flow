import { useMutation } from '@tanstack/react-query';
import type { AttachmentId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { downloadMessageFile, type MessageAttachment, type MessagePreview } from './api.js';

/**
 * What hangs off a message besides its text: files and link previews
 * (Wave 3, ai/phase-5-chat.md §3.10).
 *
 * ## Neither of these renders anything a server chose as markup
 *
 * A link preview's title, description and site name came from a third-party
 * host, fetched because somebody pasted a URL. They are rendered as TEXT — React
 * escapes them, and there is no `dangerouslySetInnerHTML` anywhere in this
 * codebase (CLAUDE.md rule 4). A preview card is not the reason to add one.
 *
 * ## A download URL is never in the broadcast
 *
 * The attachment row carries an id and a status, never a URL. Clicking asks the
 * API for a freshly authorized, 60-second link (§3.10, Phase 4 §4) — because a
 * presigned URL is a bearer credential for the file it names, and a room's
 * audience is everyone currently subscribed rather than the one person who
 * asked.
 */

/** Statuses a file can be in, and what to say about each. */
const STATUS_LABEL: ReadonlyMap<string, string> = new Map([
  ['pending', 'Waiting for the upload to finish'],
  ['scanning', 'Scanning…'],
  ['infected', 'Malware detected — this file cannot be downloaded'],
  ['rejected', 'Rejected — the contents did not match the declared type'],
]);

export function MessageAttachments({
  attachments,
}: {
  readonly attachments: readonly MessageAttachment[];
}) {
  const toast = useToast();

  const download = useMutation({
    mutationFn: (attachmentId: AttachmentId) => downloadMessageFile(attachmentId),
    onSuccess: (result) => {
      /* Navigating rather than fetching. The URL is single-use and short-lived,
         and `Content-Disposition` carries the real filename — set by the server
         from the database, because the storage key is server-generated and
         contains nothing a client chose. */
      window.location.assign(result.url);
    },
    onError: (error) => {
      toast.failure('That file could not be downloaded', error);
    },
  });

  if (attachments.length === 0) return null;

  return (
    <ul className="mt-1 flex flex-col gap-1">
      {attachments.map((attachment) => {
        const clean = attachment.status === 'clean';
        return (
          <li
            key={attachment.attachmentId}
            className={cn(
              'flex items-center gap-2 rounded border px-2 py-1 text-xs',
              clean ? 'border-line bg-surface-raised' : 'border-warning/40 bg-warning/5',
            )}
          >
            <span aria-hidden>📎</span>
            <span className="min-w-0 flex-1 truncate text-ink">{attachment.filename}</span>

            {clean ? (
              <>
                <span className="shrink-0 text-ink-faint">{formatBytes(attachment.sizeBytes)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 shrink-0 px-1 text-[11px]"
                  disabled={download.isPending}
                  onClick={() => {
                    download.mutate(attachment.attachmentId as AttachmentId);
                  }}
                >
                  Download
                </Button>
              </>
            ) : (
              /* No download control at all for anything that is not clean —
                 not a disabled one. `presignDownload` refuses these outright,
                 so offering a button whose only outcome is an error would be
                 describing a capability that does not exist. */
              <span className="shrink-0 text-warning">
                {STATUS_LABEL.get(attachment.status) ?? attachment.status}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function MessagePreviews({ previews }: { readonly previews: readonly MessagePreview[] }) {
  if (previews.length === 0) return null;

  return (
    <ul className="mt-1 flex flex-col gap-1">
      {previews.map((preview) => (
        <li
          key={preview.url}
          className="max-w-md overflow-hidden rounded border-l-2 border-accent bg-surface-raised"
        >
          <a
            href={preview.url}
            target="_blank"
            /* `noopener` matters here more than on an ordinary link: the target
               is a site somebody pasted, and without it the opened page gets a
               handle to this window via `window.opener`. `noreferrer` keeps the
               channel's URL out of that site's logs. */
            rel="noopener noreferrer"
            className="flex flex-col gap-0.5 px-2 py-1.5 hover:bg-surface-hover"
          >
            {preview.siteName !== null && (
              <span className="truncate text-[11px] text-ink-faint">{preview.siteName}</span>
            )}
            {preview.title !== null && (
              <span className="truncate text-xs font-medium text-ink">{preview.title}</span>
            )}
            {preview.description !== null && (
              <span className="line-clamp-2 text-[11px] text-ink-muted">{preview.description}</span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Bytes as something a person reads. Null until `confirm` has measured it. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
