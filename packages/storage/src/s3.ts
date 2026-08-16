import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  ObjectMetadata,
  PresignUploadOptions,
  PresignedUpload,
  StorageProvider,
} from '@taskflow/contracts';
import { safeDispositionName } from './keys.js';

/**
 * S3-compatible object storage (PLAN.md §5, §8.4).
 *
 * One implementation serves MinIO in development, Cloudflare R2 on the free
 * tier, and S3 past 10 GB — all three speak the same API, so the difference is
 * an endpoint and a credential. The `StorageProvider` interface exists to pin
 * the SECURITY behaviour rather than to paper over API differences, and this
 * file is where that behaviour actually happens.
 *
 * ## The API never touches the bytes
 *
 * Uploads go browser -> storage directly, via a presigned PUT. Proxying them
 * through the API would mean every attachment occupies a request worker for the
 * length of the transfer, and would put untrusted bytes in the process that
 * holds the database connection. `getStream` is the deliberate exception, used
 * only for server-side processing — magic-byte sniffing and virus scanning —
 * and never for serving a download.
 *
 * ## What the signature pins, and what it does not
 *
 * `presignUpload` binds `Content-Type` and `Content-Length` into the signature,
 * so storage itself rejects a body that disagrees. That is genuinely useful and
 * it is not sufficient: it proves the client SAID `image/png` twice, not that
 * the bytes are a PNG. `verifyMagicBytes` is the step that closes that gap, and
 * it runs on confirm — see the attachment service.
 */

export interface S3Config {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Path-style addressing (`host/bucket/key`) rather than virtual-host style
   * (`bucket.host/key`).
   *
   * Required for MinIO, which has no per-bucket DNS. R2 and S3 accept either.
   */
  readonly forcePathStyle?: boolean;
}

/** Presigned URLs are short-lived by default — §8.4 specifies 60 seconds for downloads. */
const DEFAULT_DOWNLOAD_TTL_SECONDS = 60;

/**
 * Uploads get longer, because the clock starts before a slow connection begins
 * a large transfer. Still minutes, not hours: the URL is a bearer credential
 * for writing one specific key.
 */
const DEFAULT_UPLOAD_TTL_SECONDS = 300;

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Issues a presigned PUT.
   *
   * `ContentLength` is part of the signed request, so a client cannot send more
   * bytes than were authorized — which matters because the size was checked
   * against a quota before this was called, and without pinning it the check
   * would be advice rather than a limit.
   */
  async presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    const expiresIn = options.expiresInSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: options.key,
      ContentType: options.contentType,
      ContentLength: options.maxBytes,
    });

    /* `signableHeaders` is what actually pins the type and size, and it is not
       optional decoration.

       A SigV4 presigned URL only covers the headers named in
       `X-Amz-SignedHeaders`, and by default that is `host` alone — so setting
       ContentType on the command above puts it in the canonical request the
       SDK builds and NOT in what storage verifies. The first version of this
       file did exactly that, documented the type as "pinned", and a test
       uploading HTML under a `text/plain` signature was accepted by MinIO.

       Naming them here makes the upload fail the signature check unless the
       client sends precisely these values. */
    const url = await getSignedUrl(this.client, command, {
      expiresIn,
      signableHeaders: new Set(['content-type', 'content-length']),
    });

    return {
      url,
      /* The client MUST send these for the signature to validate. Returning
         them explicitly rather than documenting them means a browser cannot
         accidentally omit one and get a 403 nobody can explain. */
      headers: {
        'Content-Type': options.contentType,
        'Content-Length': String(options.maxBytes),
      },
      key: options.key,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  /**
   * Issues a short-lived download URL.
   *
   * The URL carries no identity — anyone holding it can fetch the object until
   * it expires — so the caller must perform an authorization check immediately
   * before calling this, and must keep the TTL short. Both are stated on the
   * interface; this implementation only enforces the second.
   */
  async presignDownload(
    key: string,
    expiresInSeconds?: number,
    filename?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      /* `ResponseContentDisposition` is what makes the browser DOWNLOAD the
         object rather than navigate to it: without it a PDF or image opens
         inline in the tab, which is the "Download did nothing" bug. The name
         goes through `safeDispositionName` because it lands in a response
         header verbatim — a filename full of quotes or control characters
         would end the quoted-string early and let the rest become header
         parameters (see keys.ts).

         The real filename comes from the DATABASE row, never from a key or a
         client: the storage key is server-generated and contains nothing a
         person chose (keys.ts), so the disposition is the one place the
         human-readable name is allowed to exist. */
      ...(filename === undefined
        ? {}
        : {
            ResponseContentDisposition: `attachment; filename="${safeDispositionName(filename)}"`,
          }),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS,
    });
  }

  /**
   * Reads object metadata, or undefined when the object is not there.
   *
   * "Not there" is a normal outcome — it is how the confirm path discovers that
   * a client presigned an upload and never performed it — so a 404 becomes
   * `undefined` rather than an exception.
   */
  async head(key: string): Promise<ObjectMetadata | undefined> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        key,
        size: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        etag: (response.ETag ?? '').replace(/"/g, ''),
        lastModified: response.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /**
   * Streams an object into the process.
   *
   * Server-side processing only — scanning, thumbnailing, export generation.
   * Never for serving a download to a user; that is `presignDownload`.
   */
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    const body = response.Body;
    if (!body) throw new Error(`Object ${key} has no body.`);

    return body.transformToWebStream();
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    /* Server-side write only — see the interface's own note on why this does
       not reopen the "API never receives the bytes" rule. `ContentLength` is
       set explicitly because the SDK cannot infer it from a Uint8Array without
       buffering, and an absent length makes S3 use chunked encoding that some
       S3-compatible backends reject. */
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        // The source is bucket-qualified and URI-encoded; a key containing a
        // space or a `+` is otherwise silently copied from the wrong object.
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey)}`,
        Key: destinationKey,
      }),
    );
  }

  /** Releases the underlying HTTP agent. Tests and graceful shutdown. */
  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Reads only the first `limit` bytes of an object.
 *
 * The magic-byte check needs 64 bytes and the scanner needs the whole file, so
 * these are separate calls on purpose: pulling a 20 MB attachment into memory
 * to look at its first eight bytes would make the confirm path's cost depend on
 * the size of a file that may be about to be rejected.
 */
export async function readPrefix(
  provider: StorageProvider,
  key: string,
  limit: number,
): Promise<Uint8Array> {
  const stream = await provider.getStream(key);
  const reader = stream.getReader();

  const parts: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } finally {
    // Cancel rather than drain: the rest of the object is not wanted, and
    // leaving the body unconsumed leaks a socket from the SDK's agent pool.
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const part of parts) {
    if (offset >= joined.length) break;
    joined.set(part.subarray(0, joined.length - offset), offset);
    offset += part.length;
  }
  return joined;
}

/** Reads a whole object into memory. For scanning, which needs every byte. */
export async function readAll(
  provider: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = await provider.getStream(key);
  const reader = stream.getReader();

  const parts: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      /* A hard ceiling, even though the upload signature pinned the length.
         This is the one place a lying or misconfigured storage backend could
         hand back more than was authorized, and an unbounded read there is an
         out-of-memory crash triggered by an upload. */
      if (total > maxBytes) {
        throw new Error(`Object ${key} exceeds the ${String(maxBytes)}-byte read limit.`);
      }
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const name = (error as { name?: string }).name;
  if (name === 'NotFound' || name === 'NoSuchKey') return true;

  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}
