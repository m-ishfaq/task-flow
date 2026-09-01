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
 * its own fetch-driven send path: `presign`/`confirm`/`put` are stubbed,
 * and the PUT is exercised against a real (stubbed) `put`, matching that
 * file's own `vi.fn()` approach rather than adding a second DI seam for
 * one call.
 *
 * ## Why `put` uses XMLHttpRequest, not fetch
 *
 * React Native's `fetch` implementation (OkHttp on Android,
 * NSURLSession on iOS) treats `Content-Length` as a restricted header
 * and either strips it or ignores it when set explicitly in the headers
 * map. The presigned URL is signed over BOTH `content-type` AND
 * `content-length` (`packages/storage/src/s3.ts`'s `signableHeaders`),
 * so a missing or wrong Content-Length causes a 403 signature mismatch
 * from MinIO — the upload fails silently on mobile while succeeding on
 * web, where the browser's own fetch sets the header correctly from the
 * body. `XMLHttpRequest.setRequestHeader` honours explicit headers
 * reliably on both Android and iOS, making it the correct primitive here.
 * The `put` dep makes this injectable for tests.
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
  /**
   * Executes the signed PUT to object storage. Defaults to an
   * XMLHttpRequest-based implementation (see module header). Injected so
   * tests can stub it without touching the global `fetch` or `XMLHttpRequest`.
   */
  readonly put?: (url: string, headers: Record<string, string>, body: Blob) => Promise<void>;
}

/**
 * Default PUT implementation using XMLHttpRequest.
 *
 * XHR honours explicit `Content-Length` / `Content-Type` headers on React
 * Native reliably; `fetch` does not (see module header). This function is
 * not exported — callers provide a stub via `deps.put` in tests.
 */
function xhrPut(url: string, headers: Record<string, string>, body: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new Error(
            `Storage refused the upload (${String(xhr.status)}). The file may not match the type or size that was signed.`,
          ),
        );
      }
    };
    xhr.onerror = () => {
      reject(new Error('Upload failed — network error.'));
    };
    xhr.send(body);
  });
}

export async function uploadMessageFile(
  deps: UploadMessageFileDeps,
  messageId: string,
  file: PickedFile,
  onProgress?: (stage: string) => void,
): Promise<{ readonly status: 'clean' | 'infected' | 'rejected'; readonly reason?: string }> {
  const doPut = deps.put ?? xhrPut;

  onProgress?.('Requesting an upload URL…');
  const presigned = await deps.presign({
    messageId,
    filename: file.name,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  });

  onProgress?.('Uploading…');
  await doPut(presigned.url, presigned.headers, file.blob);

  onProgress?.('Scanning…');
  return deps.confirm({ attachmentId: presigned.attachmentId });
}
