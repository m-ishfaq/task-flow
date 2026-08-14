/**
 * The file picker's `accept` attribute for every upload control that goes
 * through `work.attachments`/`chat` attachments.
 *
 * A courtesy, not a control — the real enforcement is server-side, in
 * `packages/security/src/magic-bytes.ts`'s `ACCEPTED_CONTENT_TYPES` (a Zod
 * enum built from that same list) and the magic-byte check on confirm. This
 * cannot import that list directly: `@taskflow/security`'s single entry
 * point re-exports password hashing and AES primitives alongside it, which
 * would pull argon2/node:crypto-only code into the browser bundle. So this
 * is a duplicate, kept deliberately short and in the same order as the
 * server list — the same "a copy edit, not a security control" tradeoff
 * `identity/deliver.ts` accepts for its own link-lifetime constants.
 *
 * Without this, the browser's native file picker shows every file on disk,
 * and the first a person hears their file is rejected is a raw validation
 * error after they already picked it and the upload started.
 */
export const ACCEPTED_FILE_TYPES =
  '.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.docx,.xlsx,.pptx,.txt,.csv,.json,' +
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,application/zip,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.presentationml.presentation,' +
  'text/plain,text/csv,application/json';
