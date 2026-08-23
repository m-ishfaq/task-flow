/**
 * The three-step upload, ported from `apps/web/src/features/chat/api.ts`'s
 * own `uploadMessageFile` — mobile's chat composer's file-attaching half,
 * the last named gap against web's Chat surface (`channel/[channelId].tsx`'s
 * own header lists what closed before this).
 *
 * Two properties worth not losing while reading it, identical to web's own
 * header on this:
 *
 *   * The PUT does not go through our API. It is a signed URL to object
 *     storage, and `presigned.headers` are sent VERBATIM because they are
 *     the headers named in the signature — altering or omitting one makes
 *     storage reject the upload, which is the control working.
 *   * A file is not uploaded until `confirm` says so. The PUT only means
 *     bytes reached storage; the verdict comes from reading them back,
 *     checking the magic bytes, and scanning them.
 *
 * `deps` is injected rather than calling `apiClient` directly — unlike
 * web's version, which calls `api.chat.attachments.*` inline — purely so
 * this stays unit-testable the way `push-provider.test.ts` already tests
 * its own fetch-driven send path: `presign`/`confirm` are stubbed, and the
 * PUT is exercised against a real (stubbed) `fetch`, matching that file's
 * own `vi.stubGlobal('fetch', ...)` approach rather than adding a second
 * DI seam for one call.
 *
 * Deliberately has no `react-native`/`expo-document-picker` import of its
 * own, so it parses under Vitest — `pick-attachment.ts` is the native-
 * touching half that turns a device pick into the `PickedFile` this module
 * consumes, the same "pure logic in its own file" split
 * `notification-path.ts`'s own header documents for the identical reason.
 */

export interface PickedFile {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly blob: Blob;
}

export interface UploadMessageFileDeps {
  // Property function types, not method shorthand — a `vi.fn()` stub passed
  // as one of these and later handed to `expect(...).toHaveBeenCalledWith`
  // trips `@typescript-eslint/unbound-method` if declared as a method,
  // since that rule cannot tell a bound mock from a real `this`-using
  // method.
  readonly presign: (input: {
    readonly messageId: string;
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

export async function uploadMessageFile(
  deps: UploadMessageFileDeps,
  messageId: string,
  file: PickedFile,
  onProgress?: (stage: string) => void,
): Promise<{ readonly status: 'clean' | 'infected' | 'rejected'; readonly reason?: string }> {
  onProgress?.('Requesting an upload URL…');
  const presigned = await deps.presign({
    messageId,
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
