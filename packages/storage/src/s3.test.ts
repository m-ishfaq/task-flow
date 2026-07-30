import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageProvider, readAll, readPrefix, type S3Config } from './s3.js';
import { newStorageKey } from './keys.js';

/**
 * The storage provider against real MinIO (`docker compose up -d`).
 *
 * This is the contract test §5 requires of every `StorageProvider`
 * implementation — MinIO here, R2 and S3 later, same assertions. Mocking the S3
 * client would prove the mock agrees with itself; the properties that matter
 * are all decided by the storage service:
 *
 *   - a presigned PUT rejects a body whose type does not match the signature
 *   - objects are private, so an unsigned GET fails
 *   - a presigned GET expires
 *
 * Every one of those is a claim about the SIGNATURE, and only a real
 * implementation can be wrong about it.
 */

const CONFIG: S3Config = {
  endpoint: process.env['STORAGE_ENDPOINT'] ?? 'http://localhost:9000',
  region: process.env['STORAGE_REGION'] ?? 'us-east-1',
  bucket: process.env['STORAGE_BUCKET'] ?? 'taskflow-attachments',
  accessKeyId: process.env['STORAGE_ACCESS_KEY_ID'] ?? 'taskflow',
  secretAccessKey: process.env['STORAGE_SECRET_ACCESS_KEY'] ?? 'taskflow-dev-secret',
  // MinIO has no per-bucket DNS.
  forcePathStyle: true,
};

const ORG = '0195cc00-0000-7000-8000-0000000000ff';

let provider: S3StorageProvider;
let available = false;
const written: string[] = [];

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Uploads through the presigned URL, exactly as a browser would. */
async function put(key: string, body: Uint8Array, contentType: string): Promise<Response> {
  const presigned = await provider.presignUpload({
    key,
    contentType,
    maxBytes: body.length,
  });

  written.push(key);

  return fetch(presigned.url, {
    method: 'PUT',
    headers: presigned.headers,
    body,
  });
}

beforeAll(async () => {
  provider = new S3StorageProvider(CONFIG);

  try {
    await provider.head('probe/does-not-exist');
    available = true;
  } catch {
    console.warn(
      `MinIO is not answering on ${String(CONFIG.endpoint)} — skipping storage tests. ` +
        'Run `docker compose up -d`.',
    );
  }
}, 20_000);

afterAll(async () => {
  if (available) {
    for (const key of written) {
      await provider.delete(key).catch(() => undefined);
    }
  }
  provider.destroy();
});

describe('presigned uploads', () => {
  it('accepts a body matching the signed type and length', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    const response = await put(key, encode('hello world'), 'text/plain');

    expect(response.ok).toBe(true);

    const metadata = await provider.head(key);
    expect(metadata?.size).toBe(11);
    expect(metadata?.contentType).toBe('text/plain');
  }, 30_000);

  it('rejects a body sent with a different content type', async () => {
    if (!available) return;

    /* The signature pins Content-Type, so storage itself refuses the mismatch —
       this is not our validation, which is the point. It is also NOT
       sufficient: it proves the client said text/plain twice, not that the
       bytes are text. That gap is what verifyMagicBytes closes. */
    const key = newStorageKey(ORG);
    const presigned = await provider.presignUpload({
      key,
      contentType: 'text/plain',
      maxBytes: 5,
    });
    written.push(key);

    const response = await fetch(presigned.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html', 'Content-Length': '5' },
      body: encode('hello'),
    });

    expect(response.ok).toBe(false);
  }, 30_000);

  it('rejects a body longer than the signed length', async () => {
    if (!available) return;

    // The size was checked against a quota before presigning. Without the
    // length in the signature that check would be advice rather than a limit.
    const key = newStorageKey(ORG);
    const presigned = await provider.presignUpload({
      key,
      contentType: 'text/plain',
      maxBytes: 5,
    });
    written.push(key);

    /* Only Content-Type is set by hand. `fetch` computes Content-Length from
       the body itself, so this sends 35 where the signature says 5 — which is
       exactly what a client trying to exceed its quota would do, and it is why
       setting the header manually here would test nothing: undici overrides a
       hand-written Content-Length with the real body length anyway, and a
       header that disagrees with the body just makes the request hang. */
    const response = await fetch(presigned.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: encode('considerably longer than five bytes'),
    });

    expect(response.ok).toBe(false);
  }, 30_000);

  it('reports an expiry the caller can act on', async () => {
    if (!available) return;

    const presigned = await provider.presignUpload({
      key: newStorageKey(ORG),
      contentType: 'text/plain',
      maxBytes: 10,
      expiresInSeconds: 120,
    });

    expect(presigned.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(presigned.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 121_000);
  }, 30_000);
});

describe('objects are private', () => {
  it('refuses an unsigned GET', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('secret contents'), 'text/plain');

    /* The bucket is created with `mc anonymous set none`. If this ever starts
       passing, every attachment in the system is world-readable to anyone who
       can guess a key — which is the single worst outcome this package can
       produce, and it would be silent. */
    const response = await fetch(`${String(CONFIG.endpoint)}/${CONFIG.bucket}/${key}`);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  }, 30_000);

  it('allows a GET through a presigned URL', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('readable via signature'), 'text/plain');

    const url = await provider.presignDownload(key, 60);
    const response = await fetch(url);

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe('readable via signature');
  }, 30_000);

  it('issues download URLs that expire', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('briefly readable'), 'text/plain');

    // One second, then wait it out. §8.4 specifies 60 seconds in production;
    // what matters here is that the expiry is real.
    const url = await provider.presignDownload(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const response = await fetch(url);
    expect(response.ok).toBe(false);
  }, 30_000);
});

describe('reading objects server-side', () => {
  it('reads only the prefix the caller asked for', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('A'.repeat(100_000)), 'text/plain');

    /* The magic-byte check needs 64 bytes. Pulling a 20 MB attachment into
       memory to look at its first eight would make the confirm path's cost
       depend on the size of a file that may be about to be rejected. */
    const prefix = await readPrefix(provider, key, 64);
    expect(prefix.length).toBe(64);
  }, 30_000);

  it('reads a whole object for scanning', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('scan me'), 'text/plain');

    const all = await readAll(provider, key, 1024);
    expect(new TextDecoder().decode(all)).toBe('scan me');
  }, 30_000);

  it('refuses to read past its ceiling', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('B'.repeat(50_000)), 'text/plain');

    /* The upload signature already pinned the length, so this is the backstop
       for a lying or misconfigured backend. An unbounded read there is an
       out-of-memory crash triggered by an upload. */
    await expect(readAll(provider, key, 1024)).rejects.toThrow(/exceeds/);
  }, 30_000);
});

describe('metadata and lifecycle', () => {
  it('returns undefined for an object that was never uploaded', async () => {
    if (!available) return;

    // How the confirm path discovers that a client presigned and never PUT.
    // A normal outcome, so not an exception.
    expect(await provider.head(newStorageKey(ORG))).toBeUndefined();
  }, 30_000);

  it('deletes an object', async () => {
    if (!available) return;

    const key = newStorageKey(ORG);
    await put(key, encode('temporary'), 'text/plain');
    expect(await provider.head(key)).toBeDefined();

    await provider.delete(key);
    expect(await provider.head(key)).toBeUndefined();
  }, 30_000);

  it('copies server-side', async () => {
    if (!available) return;

    const source = newStorageKey(ORG);
    const destination = newStorageKey(ORG);
    await put(source, encode('duplicate me'), 'text/plain');
    written.push(destination);

    await provider.copy(source, destination);

    const url = await provider.presignDownload(destination, 60);
    expect(await (await fetch(url)).text()).toBe('duplicate me');
  }, 30_000);
});
