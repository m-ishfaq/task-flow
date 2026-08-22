/**
 * The document picker's `type` filter for every upload control that goes
 * through `chat.attachments` — the mobile counterpart of
 * `apps/web/src/lib/accepted-file-types.ts`.
 *
 * A courtesy, not a control — the real enforcement is server-side, in
 * `packages/security/src/magic-bytes.ts`'s `ACCEPTED_CONTENT_TYPES` and the
 * magic-byte check on confirm. Kept as MIME types only, unlike web's own
 * list: `expo-document-picker`'s `type` option takes MIME types (or an
 * everything-wildcard), not the mixed extension-plus-MIME-type string a
 * browser's `accept` attribute understands, so the extension half of web's
 * list has no equivalent here. Kept in the same order as that file for the
 * same reason its own header gives for not importing the server list
 * directly — a duplicate, deliberately short, not the security boundary.
 */
export const ACCEPTED_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/json',
];
