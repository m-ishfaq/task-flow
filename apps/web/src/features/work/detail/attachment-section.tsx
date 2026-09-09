import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import type { AttachmentId, CardId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { formatBytes } from '../../../lib/format.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../../components/primitives.js';
import { ErrorText, ErrorView } from '../../../components/error-view.js';
import { ACCEPTED_FILE_TYPES } from '../../../lib/accepted-file-types.js';
import { attachmentsQuery } from '../api.js';

/**
 * Attachments (§8.4). ⚠ Part of a human-review surface (§2.2).
 *
 * ## The three steps, and why the browser does all of them
 *
 * presign → PUT to storage → confirm. The file never passes through the API,
 * which is why the API's body limit is 1 MB and can stay there.
 *
 * ## What this component must never do
 *
 * **Never treat a successful PUT as a successful upload.** The object exists in
 * storage the moment the browser's PUT finishes and nothing can prevent that —
 * what the server controls is whether anyone is ever handed a URL to it. The
 * verdict comes from `confirm`, which reads the bytes back, checks the magic
 * bytes, and scans them. A UI that renders a download link after the PUT would
 * be linking to a file that has not been scanned.
 *
 * **Never offer a download for anything but `clean`.** `presignDownload` refuses
 * every other status with a 404, so a link on a `pending` row is a button that
 * cannot work; on an `infected` row it is a button that must not.
 *
 * `rejected` covers a scanner that could not answer. The scan fails CLOSED — an
 * unreachable clamd, a timeout, and an unrecognized reply all become `error`,
 * and the service treats that as a refusal. So a rejected file here may mean
 * "we could not check", and the wording says so rather than accusing the file.
 */

export interface AttachmentSectionProps {
  readonly orgId: string;
  readonly cardId: CardId;
  /**
   * `card:update` — gates uploading a new file and removing an existing one.
   * `attachment:upload` is technically its own permission in the catalog, but
   * `RELATION_GRANTS` puts it on `editor` alongside `update` and on neither
   * `viewer` nor `commenter`, so this one boolean already answers both for
   * every guest relation. Downloading stays open to anyone here: `viewer`'s
   * own `actions` list already includes `download` directly.
   */
  readonly canEdit: boolean;
}

/**
 * The status column's state machine, as wording.
 *
 * A `Map` rather than a `Record`, for the same reason `findField` in
 * packages/filter is one: the key comes from the server as a plain string, and a
 * `Record` lookup would TYPE as `string` while being `undefined` at runtime for
 * a status this build has not heard of. `.get()` says so, and the fallback below
 * shows the raw value instead of a blank line.
 */
const STATUS_TEXT: ReadonlyMap<string, string> = new Map([
  ['pending', 'Waiting for the upload to finish'],
  ['scanning', 'Scanning'],
  ['clean', 'Ready'],
  ['infected', 'Malware detected — this file cannot be downloaded'],
  ['rejected', 'Refused: the contents did not match the declared type, or it could not be scanned'],
]);

export function AttachmentSection({ orgId, cardId, canEdit }: AttachmentSectionProps) {
  const queryClient = useQueryClient();
  const attachments = useQuery(attachmentsQuery(orgId, cardId));
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.attachments(orgId, cardId) });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress('Requesting an upload URL…');
      const presigned = await api.work.attachments.presign.mutate({
        cardId,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      setProgress('Uploading…');
      /* The one `fetch` in this app that does not go through the tRPC client,
         and it is not talking to our API: this is a signed URL to object
         storage. The headers come from the server and are sent VERBATIM —
         they are the ones named in the signature (`signableHeaders`), so
         altering or omitting one makes storage reject the upload. That is the
         control working: the type and length are pinned in the signature, not
         merely requested. */
      const response = await fetch(presigned.url, {
        method: 'PUT',
        headers: presigned.headers,
        body: file,
      });

      if (!response.ok) {
        throw new Error(
          `Storage refused the upload (${String(response.status)}). The file may not match the type or size that was signed.`,
        );
      }

      setProgress('Scanning…');
      /* The verdict. A file is not uploaded until this says so — the PUT only
         means bytes reached storage. */
      return api.work.attachments.confirm.mutate({
        attachmentId: presigned.attachmentId,
      });
    },
    onSettled: async () => {
      setProgress(null);
      if (inputRef.current !== null) inputRef.current.value = '';
      await refresh();
    },
  });

  const download = useMutation({
    mutationFn: (attachmentId: AttachmentId) =>
      api.work.attachments.download.mutate({ attachmentId }),
    onSuccess: (result) => {
      /* Navigating rather than fetching. The URL is single-use and short-lived,
         and `Content-Disposition` carries the real filename — set by the server
         from the database, because the storage KEY is server-generated and
         contains nothing a client chose. */
      window.location.assign(result.url);
    },
  });

  const remove = useMutation({
    mutationFn: (attachmentId: AttachmentId) =>
      api.work.attachments.delete.mutate({ attachmentId }),
    onSuccess: refresh,
  });

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <Paperclip aria-hidden="true" className="size-3" strokeWidth={2.25} />
        Attachments
      </h3>

      <ul className="space-y-1">
        {(attachments.data ?? []).map((attachment) => {
          const status = attachment.status;
          /* The single most important line in this component. `presignDownload`
             refuses anything but `clean` with a 404, so offering the control for
             any other status is at best a button that cannot work — and on an
             `infected` row, one that must not. */
          const downloadable = status === 'clean';

          return (
            <li
              key={attachment.attachmentId}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink" title={attachment.filename}>
                  {attachment.filename}
                </p>
                <p
                  className={cn(
                    'text-[11px]',
                    status === 'infected'
                      ? 'text-danger'
                      : status === 'rejected'
                        ? 'text-warning'
                        : 'text-ink-faint',
                  )}
                >
                  {attachment.sizeBytes !== null && `${formatBytes(attachment.sizeBytes)} · `}
                  {STATUS_TEXT.get(status) ?? status}
                </p>
              </div>

              {downloadable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={download.isPending}
                  onClick={() => {
                    download.mutate(attachment.attachmentId as AttachmentId);
                  }}
                >
                  Download
                </Button>
              )}

              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => {
                    remove.mutate(attachment.attachmentId as AttachmentId);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {canEdit && (
        <input
          ref={inputRef}
          type="file"
          aria-label="Attach a file"
          accept={ACCEPTED_FILE_TYPES}
          disabled={upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) upload.mutate(file);
          }}
          className="block w-full text-xs text-ink-muted file:mr-2 file:rounded file:border-0 file:bg-surface-hover file:px-2 file:py-1 file:text-xs file:text-ink"
        />
      )}

      {progress !== null && <p className="text-[11px] text-ink-faint">{progress}</p>}

      {/* A refusal is a normal outcome, not an exception — `confirm` returns a
          status rather than throwing — so it renders here rather than as an
          error, with the reason the server gave. */}
      {upload.data !== undefined && upload.data.status !== 'clean' && (
        <p className="text-xs text-warning">
          {STATUS_TEXT.get(upload.data.status) ?? upload.data.status}
          {upload.data.reason !== undefined && ` (${upload.data.reason})`}
        </p>
      )}

      {upload.isError && <ErrorView error={upload.error} title="The upload did not complete" />}
      {download.isError && <ErrorText error={download.error} />}
      {remove.isError && <ErrorText error={remove.error} />}
    </section>
  );
}
