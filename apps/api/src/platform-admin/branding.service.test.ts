import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type StorageProvider } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { isScannerReady } from '@taskflow/security';
import type { ObjectMetadata, PresignedUpload, PresignUploadOptions } from '@taskflow/contracts';
import { TEST_ENV } from '../testing/fixtures.js';
import * as branding from './branding.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * Platform-wide branding (migration 0073), against real Postgres.
 *
 * Scoped to the properties a weaker (mocked) version could not prove:
 *
 *   - The singleton row exists from the moment the migration runs, and
 *     `setBranding` writes ONLY the field it was asked to change — a bug
 *     here silently blanks the other field, since the same UPDATE statement
 *     touches both columns.
 *   - The operator audit chain and the `brandingUpdated` event both record
 *     WHICH fields changed, not just that something did.
 *   - A clean upload becomes the live logo; the previous key (when there was
 *     one) is deleted from storage in the same call.
 *
 * The upload assertions need a real clamd, like `attachment.service.test.ts`
 * — skipped rather than mocked when one is not reachable, per this repo's
 * own convention (`ai/` status notes: a scan mock proves the test agrees
 * with itself, not that the scanner is really being asked).
 *
 * `branding-cache.ts`'s own cached read (`getResolvedBranding`) is
 * deliberately NOT asserted here, the same restraint
 * `flag-evaluator.test.ts` shows toward its sibling `getFeatureFlags`: a
 * module-level TTL cache shared across this whole file's tests would make an
 * assertion about freshness depend on run order and timing, not on the code
 * being right.
 */

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000b1');
const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000bf');
const operator: PlatformOperator = { userId: OPERATOR, requestId };

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG of the requested size — real header, padded body, matching `attachment.service.test.ts`'s helper. */
function png(size = 64): Uint8Array {
  const out = new Uint8Array(Math.max(size, PNG_HEADER.length));
  out.set(PNG_HEADER, 0);
  return out;
}

/** Storage backed by a Map — a working implementation, not a mock with call assertions. */
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

  putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
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
let scannerReady = false;

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OPERATOR]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'branding-operator@platform.test', 'branding-operator@platform.test', now())`,
    [OPERATOR],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-branding-svc' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-branding-audit' });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-branding-admin',
  });

  scannerReady = await isScannerReady({
    host: TEST_ENV.CLAMAV_HOST,
    port: TEST_ENV.CLAMAV_PORT,
    timeoutMs: 2_000,
  });
  if (!scannerReady) {
    console.warn('[branding.service.test] clamd not reachable — upload assertions skipped.');
  }
});

/* Reset the singleton back to its migration-seeded defaults before every
   test, and clear the operator chain — both are global, so a test that ran
   mid-chain could not tell its own rows from a predecessor's. */
beforeEach(async () => {
  await admin.setOrg(null);
  await admin.query(
    `UPDATE platform.branding
     SET product_name = 'TaskFlow', logo_key = NULL, favicon_key = NULL,
         palette_id = 'default', updated_by = NULL, updated_at = now()
     WHERE id = true`,
  );
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(
    `UPDATE platform.operator_chain_head SET seq = 0, hash = '\\x'::bytea WHERE id = true`,
  );
});

afterAll(async () => {
  await closeDatabase();
});

describe('the branding singleton', () => {
  it('exists from the moment the migration runs, with the seeded defaults', async () => {
    const row = await branding.getBranding(operator);
    expect(row).toEqual({
      productName: 'TaskFlow',
      logoKey: null,
      faviconKey: null,
      paletteId: 'default',
      updatedBy: null,
      updatedAt: expect.any(Date) as unknown as Date,
    });
  });

  it('updates only the field it was asked to change', async () => {
    const events = new RecordingEventBus();
    await branding.setBranding(
      { events, storage: new FakeStorage(), scanner: { host: '127.0.0.1', port: 1, timeoutMs: 1 } },
      operator,
      { productName: 'Acme Works' },
    );

    const afterName = await branding.getBranding(operator);
    expect(afterName.productName).toBe('Acme Works');
    // The field NOT named in the call must be untouched by the same UPDATE.
    expect(afterName.paletteId).toBe('default');

    await branding.setBranding(
      { events, storage: new FakeStorage(), scanner: { host: '127.0.0.1', port: 1, timeoutMs: 1 } },
      operator,
      { paletteId: 'violet' },
    );

    const afterPalette = await branding.getBranding(operator);
    // The name set by the FIRST call must survive the second, unrelated one.
    expect(afterPalette.productName).toBe('Acme Works');
    expect(afterPalette.paletteId).toBe('violet');
    expect(afterPalette.updatedBy).toBe(OPERATOR);
  });

  it('rejects a call that names no field to change', async () => {
    await expect(
      branding.setBranding(
        {
          events: new RecordingEventBus(),
          storage: new FakeStorage(),
          scanner: { host: '127.0.0.1', port: 1, timeoutMs: 1 },
        },
        operator,
        {},
      ),
    ).rejects.toThrow();
  });

  it('publishes brandingUpdated naming exactly the changed fields', async () => {
    const events = new RecordingEventBus();
    await branding.setBranding(
      { events, storage: new FakeStorage(), scanner: { host: '127.0.0.1', port: 1, timeoutMs: 1 } },
      operator,
      { productName: 'Acme Works', paletteId: 'green' },
    );

    const published = events.events.find((event) => event.name === 'platform.branding_updated');
    expect(published?.payload).toMatchObject({
      operatorUserId: OPERATOR,
      fields: expect.arrayContaining(['productName', 'paletteId']) as unknown as string[],
    });
  });

  it('records an operator action for both a read and a write', async () => {
    await branding.getBranding(operator);
    await branding.setBranding(
      {
        events: new RecordingEventBus(),
        storage: new FakeStorage(),
        scanner: { host: '127.0.0.1', port: 1, timeoutMs: 1 },
      },
      operator,
      { productName: 'Acme Works' },
    );

    const result = await admin.query(`SELECT action FROM platform.operator_audit_log ORDER BY seq`);
    const actions = result.rows.map((row) => row['action'] as string);
    expect(actions).toContain('branding.get');
    expect(actions).toContain('branding.set');
  });
});

describe('logo upload', () => {
  it('becomes the live logo on a clean verdict, and the cache sees it', async () => {
    if (!scannerReady) return;

    const storage = new FakeStorage();
    const deps: branding.BrandingDeps = {
      events: new RecordingEventBus(),
      storage,
      scanner: { host: TEST_ENV.CLAMAV_HOST, port: TEST_ENV.CLAMAV_PORT, timeoutMs: 20_000 },
    };

    const presigned = await branding.presignLogo(deps, operator, {
      contentType: 'image/png',
      sizeBytes: 128,
    });
    storage.put(presigned.storageKey, png(128), 'image/png');

    const result = await branding.confirmLogo(deps, operator, {
      storageKey: presigned.storageKey,
    });
    expect(result.status).toBe('clean');

    const row = await branding.getBranding(operator);
    expect(row.logoKey).toBe(presigned.storageKey);
  });

  it('deletes the previous logo when a new one replaces it', async () => {
    if (!scannerReady) return;

    const storage = new FakeStorage();
    const deps: branding.BrandingDeps = {
      events: new RecordingEventBus(),
      storage,
      scanner: { host: TEST_ENV.CLAMAV_HOST, port: TEST_ENV.CLAMAV_PORT, timeoutMs: 20_000 },
    };

    const first = await branding.presignLogo(deps, operator, {
      contentType: 'image/png',
      sizeBytes: 128,
    });
    storage.put(first.storageKey, png(128), 'image/png');
    await branding.confirmLogo(deps, operator, { storageKey: first.storageKey });

    const second = await branding.presignLogo(deps, operator, {
      contentType: 'image/png',
      sizeBytes: 128,
    });
    storage.put(second.storageKey, png(128), 'image/png');
    await branding.confirmLogo(deps, operator, { storageKey: second.storageKey });

    const row = await branding.getBranding(operator);
    expect(row.logoKey).toBe(second.storageKey);
    expect(storage.deleted).toContain(first.storageKey);
  });

  it('leaves the previous logo in place when the new upload is rejected', async () => {
    if (!scannerReady) return;

    const storage = new FakeStorage();
    const deps: branding.BrandingDeps = {
      events: new RecordingEventBus(),
      storage,
      scanner: { host: TEST_ENV.CLAMAV_HOST, port: TEST_ENV.CLAMAV_PORT, timeoutMs: 20_000 },
    };

    const good = await branding.presignLogo(deps, operator, {
      contentType: 'image/png',
      sizeBytes: 128,
    });
    storage.put(good.storageKey, png(128), 'image/png');
    await branding.confirmLogo(deps, operator, { storageKey: good.storageKey });

    /* A "PNG" whose body does not actually match the PNG signature — the
       magic-bytes check refuses it before a scan is even attempted. */
    const bad = await branding.presignLogo(deps, operator, {
      contentType: 'image/png',
      sizeBytes: 32,
    });
    storage.put(bad.storageKey, new Uint8Array(32), 'image/png');

    const result = await branding.confirmLogo(deps, operator, { storageKey: bad.storageKey });
    expect(result.status).toBe('rejected');

    const row = await branding.getBranding(operator);
    expect(row.logoKey).toBe(good.storageKey);
  });
});
