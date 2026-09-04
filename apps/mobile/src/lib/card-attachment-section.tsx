import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { pickAttachment } from './pick-attachment.js';
import { uploadCardAttachment } from './upload-card-attachment.js';
import { attachmentsQueryKey, formatBytes } from './work.js';
import { Section } from './card-detail-shared.js';
import { styles } from './card-detail-styles.js';

/**
 * The status column's state machine, as wording — ported verbatim from
 * `apps/web`'s own `STATUS_TEXT`. A `Map`, not a `Record`: the key comes
 * from the server as a plain string, and a `Record` lookup would TYPE as
 * `string` while being `undefined` at runtime for a status this build has
 * not heard of. `.get()` says so, and the fallback shows the raw value
 * instead of a blank line.
 */
const ATTACHMENT_STATUS_TEXT: ReadonlyMap<string, string> = new Map([
  ['pending', 'Waiting for the upload to finish'],
  ['scanning', 'Scanning'],
  ['clean', 'Ready'],
  ['infected', 'Malware detected — this file cannot be downloaded'],
  ['rejected', 'Refused: the contents did not match the declared type, or it could not be scanned'],
]);

/**
 * Attachments on a card — `apps/web`'s `AttachmentSection` (⚠ human-review
 * surface, CLAUDE.md §2.2: any file upload/download path), the mobile
 * counterpart of Chat's already-shipped composer attaching
 * (`channel/[channelId].tsx`'s "Chat, complete" section). Reuses
 * `pick-attachment.ts` unchanged and `upload-card-attachment.ts` for the
 * three-step presign/PUT/confirm pipeline — see that file's own header
 * for why it is a separate module from Chat's rather than one shared
 * uploader.
 *
 * **The same two rules Chat's own attach flow already lives by, restated
 * here because this is a SEPARATE human-review surface from that one:**
 * a successful PUT is never treated as a successful upload — the object
 * exists in storage the moment the PUT finishes and nothing can prevent
 * that, so only `confirm`'s verdict (magic bytes checked, scanned)
 * decides whether anyone is ever handed a download URL. And a download is
 * only ever offered for `status === 'clean'` — `presignDownload` refuses
 * every other status with a 404, so offering the control on a `pending`
 * row is a button that cannot work, and on an `infected` row one that
 * must not.
 *
 * Unlike Chat's version there is no "send a message first" step — a
 * card, unlike a chat message, already exists by the time this screen can
 * render at all, so `presign` goes straight to `cardId`.
 */
export function AttachmentSection({ cardId }: { readonly cardId: CardId }) {
  const queryClient = useQueryClient();
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{
    readonly kind: 'success' | 'failure';
    readonly text: string;
  } | null>(null);

  const attachments = useQuery({
    queryKey: attachmentsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.attachments.list.query({ cardId })),
  });

  const upload = useMutation({
    mutationFn: (file: Awaited<ReturnType<typeof pickAttachment>>) => {
      if (file === null) return Promise.resolve(null);
      setUploadNotice(null);
      return uploadCardAttachment(
        {
          presign: (input) => apiClient.work.attachments.presign.mutate(input),
          confirm: (input) => apiClient.work.attachments.confirm.mutate(input),
        },
        cardId,
        file,
        setUploadStage,
      );
    },
    onSuccess: (result) => {
      if (result === null) return;
      if (result.status === 'clean') {
        setUploadNotice({ kind: 'success', text: 'File uploaded.' });
      } else {
        setUploadNotice({
          kind: 'failure',
          text:
            result.status === 'infected'
              ? 'That file was rejected: malware detected.'
              : `That file was rejected: ${result.reason ?? 'it did not pass verification.'}`,
        });
      }
    },
    onError: () => {
      setUploadNotice({ kind: 'failure', text: 'The file was not uploaded.' });
    },
    onSettled: async () => {
      setUploadStage(null);
      await queryClient.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
    },
  });

  const download = useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.work.attachments.download.mutate({ attachmentId }),
    onSuccess: (result) => {
      void Linking.openURL(result.url);
    },
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.work.attachments.delete.mutate({ attachmentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
    },
  });

  return (
    <Section label="Attachments">
      {(attachments.data ?? []).map((attachment) => {
        const downloadable = attachment.status === 'clean';
        return (
          <View key={attachment.attachmentId} style={styles.attachmentRow}>
            <View style={styles.attachmentInfo}>
              <Text style={styles.attachmentName} numberOfLines={1}>
                {attachment.filename}
              </Text>
              <Text
                style={[
                  styles.attachmentStatus,
                  attachment.status === 'infected' && styles.attachmentStatusDanger,
                  attachment.status === 'rejected' && styles.attachmentStatusWarning,
                ]}
              >
                {attachment.sizeBytes !== null && `${formatBytes(attachment.sizeBytes)} · `}
                {ATTACHMENT_STATUS_TEXT.get(attachment.status) ?? attachment.status}
              </Text>
            </View>
            {downloadable && (
              <Pressable
                disabled={download.isPending}
                onPress={() => {
                  download.mutate(attachment.attachmentId);
                }}
              >
                <Text style={styles.checklistDeleteText}>Download</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                remove.mutate(attachment.attachmentId);
              }}
            >
              <Text style={styles.checklistDeleteText}>Remove</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable
        disabled={upload.isPending}
        onPress={() => {
          void pickAttachment().then((file) => {
            upload.mutate(file);
          });
        }}
      >
        <Text style={styles.checklistAddItemText}>+ Attach a file</Text>
      </Pressable>

      {uploadStage !== null && <Text style={styles.emptyHint}>{uploadStage}</Text>}
      {uploadNotice !== null && (
        <Text
          style={uploadNotice.kind === 'failure' ? styles.error : styles.emptyHint}
          accessibilityRole={uploadNotice.kind === 'failure' ? 'alert' : undefined}
        >
          {uploadNotice.text}
        </Text>
      )}
      {(download.isError || remove.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(download.error ?? remove.error)?.error.message ??
            'That action could not be completed.'}
        </Text>
      )}
    </Section>
  );
}
