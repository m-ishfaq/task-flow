import type { StorageProvider } from '@taskflow/contracts';
import {
  MAGIC_BYTE_PREFIX_LENGTH,
  scanBuffer,
  verifyMagicBytes,
  type ScannerConfig,
} from '@taskflow/security';
import { isGeneratedKey, readAll, readPrefix } from '@taskflow/storage';

/**
 * Deciding whether an uploaded object is safe to hand back (PLAN.md §8.4).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): a file upload/download path.
 *
 * ## Why this is its own module
 *
 * Cards had attachments first, and Phase 5 gives them to chat messages. The
 * obvious move — copy `confirmUpload` and change `cardId` to `messageId` —
 * would produce two copies of the fail-closed scanner logic, and the failure
 * mode of that is specific and bad: a fix lands on one copy. The version that
 * did not get fixed keeps working perfectly, because a scanner that wrongly
 * says "clean" looks exactly like a scanner that is right.
 *
 * So the DECISION lives here, once, and is parent-agnostic. It reads an object
 * and answers what it is. It writes nothing, deletes nothing, and emits nothing
 * — the caller owns the row, the event, and the cleanup, because those differ
 * per parent type and none of them are security-critical in the way this is.
 *
 * ## The order of the checks is load-bearing
 *
 *   1. Key shape — before the key is handed to storage at all.
 *   2. Existence and size — cheap, and bounds everything after it.
 *   3. Magic bytes — a prefix read, not the whole file.
 *   4. Virus scan — the expensive one, last, on bytes already bounded.
 *
 * Running the scan before the size check would mean an oversized object is read
 * into memory in full before being rejected for being oversized.
 */

export interface VerifyDeps {
  readonly storage: StorageProvider;
  readonly scanner: ScannerConfig;
  /** Largest upload accepted, in bytes. Also the ceiling on a server-side read. */
  readonly maxBytes: number;
}

export interface VerifyTarget {
  readonly storageKey: string;
  /** The type declared at presign time and pinned into the signature. */
  readonly contentType: string;
}

export type VerifyStatus = 'clean' | 'infected' | 'rejected';

export interface VerifyResult {
  readonly status: VerifyStatus;
  /** Why, for the audit event. Absent only when the verdict is clean. */
  readonly reason?: string;
  /** The object's true size, known only once it exists. Absent when rejected. */
  readonly sizeBytes?: number;
}

/**
 * Reads an uploaded object and decides whether it may ever be served.
 *
 * Returns a verdict rather than throwing: every outcome here is a normal result
 * that the caller records against a row, and an exception would make "rejected"
 * and "the database is down" the same control flow.
 */
export async function verifyUpload(deps: VerifyDeps, target: VerifyTarget): Promise<VerifyResult> {
  /* Backstop on a value that came from our own database. RLS already scoped the
     read, so this can only fire if a key reached a row from somewhere it should
     not have — which is exactly the case worth catching before handing it to
     the storage client. */
  if (!isGeneratedKey(target.storageKey)) {
    return { status: 'rejected', reason: 'Storage key is not one this system generated.' };
  }

  const metadata = await deps.storage.head(target.storageKey);
  if (!metadata) {
    return { status: 'rejected', reason: 'No object was uploaded.' };
  }
  if (metadata.size === 0) {
    return { status: 'rejected', reason: 'The uploaded object is empty.' };
  }
  if (metadata.size > deps.maxBytes) {
    return { status: 'rejected', reason: 'The uploaded object is larger than allowed.' };
  }

  /* Magic bytes. The presigned URL pinned Content-Type into the signature, so
     storage refused a body sent with a different HEADER — but that only proves
     the client said `image/png` twice, not that the bytes are a PNG. This is
     the step that closes that gap (§8.4). */
  const prefix = await readPrefix(deps.storage, target.storageKey, MAGIC_BYTE_PREFIX_LENGTH);
  const sniff = verifyMagicBytes(target.contentType, prefix);
  if (!sniff.ok) {
    return {
      status: 'rejected',
      reason: sniff.reason ?? 'Contents do not match the type.',
    };
  }

  const bytes = await readAll(deps.storage, target.storageKey, deps.maxBytes);
  const scan = await scanBuffer(bytes, deps.scanner);

  if (scan.verdict === 'infected') {
    return { status: 'infected', reason: scan.detail ?? 'Malware detected.' };
  }

  if (scan.verdict === 'error') {
    /* FAIL CLOSED, and this is the single most important line in the slice.
       "We could not check" is not "clean" — treating it as clean turns a
       scanner outage into a window where unscanned files are downloadable,
       while uploads keep working perfectly and nothing anywhere goes red. */
    return { status: 'rejected', reason: `Scan failed: ${scan.detail ?? 'unknown error'}` };
  }

  return { status: 'clean', sizeBytes: metadata.size };
}
