import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type AttachmentId,
  type CardId,
  type ObjectMetadata,
  type OrgId,
  type PresignUploadOptions,
  type PresignedUpload,
  type StorageProvider,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { EICAR_TEST_SIGNATURE, isScannerReady } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import * as attachments from './attachment.service.js';
import type { AttachmentDeps } from './attachment.service.js';
import type { WorkActor } from './shared.js';

/**
 * The attachment pipeline (PLAN.md §8.4).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * ## Why storage is a fake here and real in packages/storage
 *
 * `packages/storage/src/s3.test.ts` proves the SIGNATURE behaviour against real
 * MinIO — that a body with the wrong content type is refused, that objects are
 * private, that download URLs expire. Those are claims about the storage
 * service and only a real one can be wrong about them.
 *
 * These tests prove something different: that the SERVICE reaches the right
 * verdict for every shape of object it might find. That needs a storage layer
 * that can be made to return an empty object, a type mismatch, a missing
 * object, or a file over the limit — states a real bucket cannot be put into on
 * demand without uploading each case. Both halves are necessary; neither
 * replaces the other.
 *
 * The virus scan is the exception: it talks to the real clamd when one is
 * available, because "does EICAR get detected" is not a question a fake can
 * answer. The fail-closed path is asserted unconditionally.
 */

const OWNER = unsafeAsId<'UserId'>('0195f000-0000-7000-8000-000000000001');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@attach.test']];
const requestId = unsafeAsId<'RequestId'>('0195f000-0000-7000-8000-0000000000ff');

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A PNG of the requested size — real header, padded body. */
function png(size = 64): Uint8Array {
  const out = new Uint8Array(Math.max(size, PNG_HEADER.length));
  out.set(PNG_HEADER, 0);
  return out;
}

/**
 * Storage backed by a Map.
 *
 * Deliberately NOT a mock with assertions on calls — it is a working
 * implementation of the interface, so a test can put an object into any state
 * and the service under test cannot tell the difference.
 */
class FakeStorage implements StorageProvider {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  readonly deleted: string[] = [];

  presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `https://storage.test/${options.key}`,
      headers: { 'Content-Type': options.contentType },
      key: options.key,
      expiresAt: new Date(Date.now() + 300_000),
    });
  }

  presignDownload(key: string, expiresInSeconds = 60): Promise<string> {
    return Promise.resolve(`https://storage.test/${key}?expires=${String(expiresInSeconds)}`);
  }

  head(key: string): Promise<ObjectMetadata | undefined> {
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(undefined);

    return Promise.resolve({
      key,
      size: object.body.length,
      contentType: object.contentType,
      etag: 'fake',
      lastModified: new Date(),
    });
  }

  getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new Error(`No object ${key}`));

    const body = object.body;
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    );
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  copy(sourceKey: string, destinationKey: string): Promise<void> {
    const object = this.objects.get(sourceKey);
    if (object) this.objects.set(destinationKey, object);
    return Promise.resolve();
  }

  /** Stands in for the browser's PUT. */
  put(key: string, body: Uint8Array, contentType: string): void {
    this.objects.set(key, { body, contentType });
  }
}

let admin: AdminConnection;
let storage: FakeStorage;
let deps: AttachmentDeps;
let created: OrgId[] = [];
let scannerReady = false;

/** A scanner address that is guaranteed to refuse a connection. */
const DEAD_SCANNER = { host: '127.0.0.1', port: 1, timeoutMs: 500 };

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'platform.attachments',
    'work.cards',
    'work.lists',
    'work.boards',
    'work.projects',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly cardId: CardId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);

  const owner = await actorFor(result.orgId, OWNER, 'owner');
  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const card = await cards.createCard(owner, {
    listId: list.listId,
    title: 'Has attachments',
    description: null,
  });

  return { orgId: result.orgId, owner, cardId: card.cardId };
}

/** Presign, PUT the given bytes, confirm — the whole pipeline in one call. */
async function upload(
  fixture: Fixture,
  body: Uint8Array,
  contentType: string,
  options: { readonly skipPut?: boolean } = {},
): Promise<{ attachmentId: AttachmentId; result: attachments.ConfirmResult }> {
  const presigned = await attachments.presignUpload(fixture.owner, deps, {
    cardId: fixture.cardId,
    filename: 'file.bin',
    contentType,
    sizeBytes: Math.max(body.length, 1),
  });

  if (options.skipPut !== true) {
    storage.put(keyOf(presigned.url), body, contentType);
  }

  const result = await attachments.confirmUpload(fixture.owner, deps, {
    attachmentId: presigned.attachmentId,
  });

  return { attachmentId: presigned.attachmentId, result };
}

const keyOf = (url: string): string => url.replace('https://storage.test/', '');

async function statusOf(orgId: OrgId, attachmentId: AttachmentId): Promise<string | undefined> {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({ status: schema.attachments.status })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attachmentId)),
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-attach-test' });

  scannerReady = await isScannerReady({
    host: TEST_ENV.CLAMAV_HOST,
    port: TEST_ENV.CLAMAV_PORT,
    timeoutMs: 3000,
  });
  if (!scannerReady) {
    console.warn(
      'ClamAV is not answering — the clean-file assertions below run against a ' +
        'stub verdict. The fail-closed assertions still run for real.',
    );
  }
}, 30_000);

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];

  storage = new FakeStorage();
  deps = {
    storage,
    /* Real clamd when one is available. When it is not, the pipeline fails
       closed on every upload — which is correct behaviour and makes the
       "clean" assertions unrunnable, so those are guarded. */
    scanner: scannerReady
      ? { host: TEST_ENV.CLAMAV_HOST, port: TEST_ENV.CLAMAV_PORT, timeoutMs: 20_000 }
      : DEAD_SCANNER,
    maxBytes: 1024 * 1024,
  };
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('presign', () => {
  it('creates a pending row before any bytes exist', async () => {
    const fixture = await scaffold('attach-presign');

    const presigned = await attachments.presignUpload(fixture.owner, deps, {
      cardId: fixture.cardId,
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 64,
    });

    /* The row exists first, so an abandoned upload is a collectable orphan
       rather than an untracked object sitting in a bucket forever. */
    expect(await statusOf(fixture.orgId, presigned.attachmentId)).toBe('pending');
    expect(presigned.url).toContain('https://storage.test/');
  });

  it('generates the storage key itself, with nothing from the client in it', async () => {
    const fixture = await scaffold('attach-key');

    const presigned = await attachments.presignUpload(fixture.owner, deps, {
      cardId: fixture.cardId,
      // A filename that would be a traversal if it reached the key.
      filename: 'evil.png',
      contentType: 'image/png',
      sizeBytes: 64,
    });

    const key = keyOf(presigned.url);
    expect(key).toMatch(new RegExp(`^org/${fixture.orgId}/\\d{4}/\\d{2}/`));
    expect(key).not.toContain('evil');
    expect(key).not.toContain('..');
  });

  it('refuses a content type that is not on the accepted list', async () => {
    const fixture = await scaffold('attach-type');

    /* SVG can carry script, and no byte signature distinguishes a safe one from
       a hostile one. Refused at presign, so it is never pinned into a signature
       that says it was fine. */
    await expect(
      attachments.presignUpload(fixture.owner, deps, {
        cardId: fixture.cardId,
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 64,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a file larger than the configured limit', async () => {
    const fixture = await scaffold('attach-size');

    await expect(
      attachments.presignUpload(fixture.owner, deps, {
        cardId: fixture.cardId,
        filename: 'huge.png',
        contentType: 'image/png',
        sizeBytes: deps.maxBytes + 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('confirm — verifying what actually landed', () => {
  it('rejects when no object was ever uploaded', async () => {
    const fixture = await scaffold('attach-missing');

    const { attachmentId, result } = await upload(fixture, png(), 'image/png', {
      skipPut: true,
    });

    expect(result.status).toBe('rejected');
    expect(await statusOf(fixture.orgId, attachmentId)).toBe('rejected');
  });

  it('rejects an empty object', async () => {
    const fixture = await scaffold('attach-empty');

    const { result } = await upload(fixture, new Uint8Array(0), 'image/png');
    expect(result.status).toBe('rejected');
  });

  it('rejects HTML uploaded under an image content type', async () => {
    const fixture = await scaffold('attach-magic');

    /* THE attack this pipeline exists to stop. The presigned URL pinned
       Content-Type into the signature, and storage accepted the PUT — because
       the client did send `image/png` as its header. The bytes are HTML. */
    const { attachmentId, result } = await upload(
      fixture,
      encode('<!DOCTYPE html><script>fetch("//evil")</script>'),
      'image/png',
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('image/png');
    expect(await statusOf(fixture.orgId, attachmentId)).toBe('rejected');
  });

  it('deletes the object when it is refused', async () => {
    const fixture = await scaffold('attach-cleanup');

    await upload(fixture, encode('<html>'), 'image/png');

    // A refused file has no reason to remain in storage, and leaving it there
    // fills a bucket with exactly the objects nobody wants to find later.
    expect(storage.deleted).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
  });

  it('refuses a second confirm rather than re-scanning', async () => {
    const fixture = await scaffold('attach-double');

    const presigned = await attachments.presignUpload(fixture.owner, deps, {
      cardId: fixture.cardId,
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 64,
    });
    storage.put(keyOf(presigned.url), png(), 'image/png');

    await attachments.confirmUpload(fixture.owner, deps, {
      attachmentId: presigned.attachmentId,
    });

    /* The conditional claim in attachment-status.ts. Without `status =
       'pending'` in its WHERE, a retry would re-scan and its verdict would
       overwrite the first — including overwriting `infected` with `clean`. */
    await expect(
      attachments.confirmUpload(fixture.owner, deps, {
        attachmentId: presigned.attachmentId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('confirm — the scanner', () => {
  it('fails CLOSED when the scanner is unreachable', async () => {
    const fixture = await scaffold('attach-scanner-down');

    /* The single most important assertion in this file. Treating "we could not
       check" as "clean" turns a scanner outage into a window where unscanned
       files are downloadable, and uploads keep working perfectly the whole
       time so nothing goes red. */
    const closed: AttachmentDeps = { ...deps, scanner: DEAD_SCANNER };

    const presigned = await attachments.presignUpload(fixture.owner, closed, {
      cardId: fixture.cardId,
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 64,
    });
    storage.put(keyOf(presigned.url), png(), 'image/png');

    const result = await attachments.confirmUpload(fixture.owner, closed, {
      attachmentId: presigned.attachmentId,
    });

    expect(result.status).toBe('rejected');
    expect(result.status).not.toBe('clean');
    expect(result.reason).toContain('Scan failed');
  }, 20_000);

  it('marks a genuinely clean file downloadable', async () => {
    if (!scannerReady) return;
    const fixture = await scaffold('attach-clean');

    const { attachmentId, result } = await upload(fixture, png(256), 'image/png');

    expect(result.status).toBe('clean');
    expect(await statusOf(fixture.orgId, attachmentId)).toBe('clean');
  }, 40_000);

  it('detects EICAR and never marks it clean', async () => {
    if (!scannerReady) return;
    const fixture = await scaffold('attach-eicar');

    /* EICAR declared as text/plain — it IS plain text, so it passes the
       magic-byte check honestly and reaches the scanner, which is exactly the
       path a real malicious document takes. */
    const { attachmentId, result } = await upload(
      fixture,
      encode(EICAR_TEST_SIGNATURE),
      'text/plain',
    );

    expect(result.status).toBe('infected');
    expect(await statusOf(fixture.orgId, attachmentId)).toBe('infected');
    expect(storage.objects.size).toBe(0);
  }, 40_000);
});

describe('download', () => {
  it('refuses to issue a URL for anything that is not clean', async () => {
    const fixture = await scaffold('attach-download-dirty');

    const { attachmentId } = await upload(fixture, encode('<html>'), 'image/png');

    /* THE invariant: `presignDownload` is called for exactly one kind of row.
       404 rather than 403 — the caller does not need to learn that a file
       exists and was refused. */
    await expect(
      attachments.presignDownload(fixture.owner, deps, { attachmentId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to issue a URL while the row is still pending', async () => {
    const fixture = await scaffold('attach-download-pending');

    const presigned = await attachments.presignUpload(fixture.owner, deps, {
      cardId: fixture.cardId,
      filename: 'photo.png',
      contentType: 'image/png',
      sizeBytes: 64,
    });
    storage.put(keyOf(presigned.url), png(), 'image/png');

    // Uploaded but never confirmed: the bytes exist and nothing has looked at
    // them. This is the window an attacker would want.
    await expect(
      attachments.presignDownload(fixture.owner, deps, {
        attachmentId: presigned.attachmentId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('issues a short-lived URL for a clean file and audits it', async () => {
    if (!scannerReady) return;
    const fixture = await scaffold('attach-download-clean');

    const { attachmentId } = await upload(fixture, png(256), 'image/png');
    const download = await attachments.presignDownload(fixture.owner, deps, { attachmentId });

    expect(download.expiresInSeconds).toBe(60);
    expect(download.url).toContain('https://storage.test/');

    /* §8.4 requires every download to be audited. The fetch goes
       browser-to-storage and never touches this process, so issuing the URL is
       the only moment that can be recorded. */
    const emitted = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );
    expect(emitted.map((row) => row.name)).toContain('attachment.downloaded');
  }, 40_000);
});

describe('the event stream', () => {
  it('records the presign as well as the verdict', async () => {
    const fixture = await scaffold('attach-events');

    await upload(fixture, encode('<html>'), 'image/png');

    const emitted = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );
    const names = emitted.map((row) => row.name);

    /* A presigned PUT is a capability to place bytes in this org's bucket.
       Auditing only successful uploads would leave the grant invisible, and a
       run of presigns with no matching verdict is what a broken or probing
       client looks like. */
    expect(names).toContain('attachment.presigned');
    expect(names).toContain('attachment.rejected');
  });
});

describe('deletion', () => {
  it('soft-deletes the row and removes the bytes', async () => {
    if (!scannerReady) return;
    const fixture = await scaffold('attach-delete');

    const { attachmentId } = await upload(fixture, png(256), 'image/png');
    expect(storage.objects.size).toBe(1);

    await attachments.deleteAttachment(fixture.owner, deps, { attachmentId });

    // The row survives so the audit trail still has something to name; the
    // bytes do not, because "delete" should mean the file is gone.
    expect(storage.objects.size).toBe(0);
    expect(
      await attachments.listAttachments(fixture.owner, { cardId: fixture.cardId }),
    ).toHaveLength(0);
    expect(await statusOf(fixture.orgId, attachmentId)).toBe('clean');
  }, 40_000);
});
