/**
 * StorageProvider — object storage (PLAN.md §5, §8.4).
 *
 * Implementations:
 *   MinioStorageProvider   local docker compose         (development)
 *   R2StorageProvider      Cloudflare R2, 10GB free     (free tier)
 *   S3StorageProvider      AWS S3                       (past 10GB)
 *
 * All three speak the S3 API, so the implementation is nearly identical — the
 * interface exists to pin the SECURITY behaviour, not to paper over API
 * differences:
 *
 *   - The API never proxies file bytes. Uploads go browser -> storage directly
 *     via a presigned URL whose signature pins content type and size, so a
 *     client cannot upload something other than what was authorized.
 *   - Objects are private. Downloads use short-lived presigned URLs issued only
 *     after a fresh authorization check.
 *   - An object is not downloadable until it has been virus-scanned (§8.4).
 */

export interface PresignedUpload {
  /** URL the browser PUTs to. Short-lived. */
  readonly url: string;
  /** Headers the client must send for the signature to validate. */
  readonly headers: Readonly<Record<string, string>>;
  /** Key the object will occupy. Server-generated, never client-supplied. */
  readonly key: string;
  readonly expiresAt: Date;
}

export interface PresignUploadOptions {
  readonly key: string;
  /**
   * Pinned into the signature. An upload with a different content type is
   * rejected by the storage service, not merely by our validation.
   */
  readonly contentType: string;
  /** Maximum bytes, also pinned into the signature. */
  readonly maxBytes: number;
  readonly expiresInSeconds?: number;
}

export interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

export interface StorageProvider {
  /** Issues a presigned upload. The API never receives the bytes. */
  presignUpload(options: PresignUploadOptions): Promise<PresignedUpload>;

  /**
   * Issues a short-lived download URL.
   *
   * Callers must perform an authorization check immediately before calling this
   * — the URL itself carries no identity, so anyone holding it can fetch the
   * object until it expires. Keep `expiresInSeconds` small (default 60).
   */
  presignDownload(key: string, expiresInSeconds?: number): Promise<string>;

  /** Reads object metadata. Used to verify a claimed upload actually landed. */
  head(key: string): Promise<ObjectMetadata | undefined>;

  /**
   * Streams an object's bytes into the API process.
   *
   * ONLY for server-side processing — virus scanning, thumbnailing, export
   * generation. Never for serving a download to a user; that is what
   * `presignDownload` is for.
   */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;

  delete(key: string): Promise<void>;

  /** Server-side copy, for duplicating a card or board without a round trip. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
}
