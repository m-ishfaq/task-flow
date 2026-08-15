import { eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { errors, type PaletteId, type StorageProvider } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import type { ScannerConfig } from '@taskflow/security';
import { newStorageKey } from '@taskflow/storage';
import { verifyUpload } from '../attachments/verify.js';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { asPaletteId, getResolvedBranding, type BrandingSnapshot } from './branding-cache.js';
import { brandingUpdated } from './events.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * Platform-wide branding — the console's fourth global singleton
 * (migration 0073).
 *
 * ⚠ Adjacent to a human-review surface: logo/favicon upload reuses
 * `attachments/verify.ts`'s `verifyUpload` (the same fail-closed magic-byte
 * + virus-scan decision every other upload path in this codebase shares —
 * see that file's own header on why it is one copy, not a second one built
 * for this feature).
 *
 * ## Why there is no "pending" status, unlike Work's attachments
 *
 * `attachment.service.ts` writes a row at `status = 'pending'` before any
 * bytes exist, so an abandoned upload is a trackable orphan. There is
 * nothing to make pending here: `platform.branding` has exactly ONE row, and
 * writing an unverified key onto it — even briefly — would make an
 * unscanned image the live site logo for whatever window elapses before
 * confirm runs. So `presignLogo` writes nothing at all; `confirmLogo` is the
 * only place `logo_key` is ever set, and only after `verifyUpload` returns
 * `clean`. The previous key, if any, is deleted from storage in the same
 * call — replacement, not accumulation, since nothing else will ever
 * reference the old object once the row stops pointing at it.
 *
 * The accepted gap this trades for: with no pending row at all, a PUT that
 * lands but is never confirmed (a network blip between the two calls, not a
 * rejected verdict) leaves a truly untracked object — no database row points
 * to it even transiently, unlike an abandoned Work attachment's `pending`
 * row a retention job can enumerate. Acceptable for v1 because this is an
 * operator-only, low-frequency action on small files, not a per-user upload
 * surface; worth a storage-level orphan sweep if it ever turns out to
 * matter, not worth inventing a pending-row table for two fields that only
 * ever have one value each.
 */

export interface BrandingRow {
  readonly productName: string;
  readonly logoKey: string | null;
  readonly faviconKey: string | null;
  readonly paletteId: PaletteId;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export interface BrandingDeps {
  readonly events: EventBus;
  readonly storage: StorageProvider;
  readonly scanner: ScannerConfig;
}

/**
 * 2 MiB — generous for a logo or favicon PNG, tight enough to bound the
 * server-side read in `verifyUpload`.
 */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * How long a served logo/favicon URL stays valid. Re-presigned on every
 * `branding.public` call, never cached alongside the row.
 */
const ASSET_URL_TTL_SECONDS = 6 * 60 * 60;

async function loadRow(): Promise<BrandingRow> {
  return withPlatformAdminScope(async (tx) => {
    const rows = await tx.select().from(schema.branding).limit(1);
    const row = rows[0];
    /* The singleton is seeded by migration 0073 and never deleted (§ this
       file's own header — UPDATE only, no DELETE grant) — a missing row
       means a database this code did not expect, not a legitimate empty
       state, so this is the one place branding reads throw rather than
       falling back to a default (contrast `branding-cache.ts`'s
       `loadBranding`, which DOES fall back, because it serves callers with
       no operator to report an error to). */
    if (!row) throw errors.notFound('Branding is not configured.');
    return {
      productName: row.productName,
      logoKey: row.logoKey,
      faviconKey: row.faviconKey,
      paletteId: asPaletteId(row.paletteId),
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * The console tab's read — always fresh, never the shared cache, same
 * reasoning `flags.service.ts`'s `listFlags` gives.
 */
export async function getBranding(operator: PlatformOperator): Promise<BrandingRow> {
  const row = await loadRow();
  await recordOperatorAction(operator.userId, 'branding.get', null);
  return row;
}

export interface BrandingRowWithPreview extends BrandingRow {
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
}

/**
 * `getBranding` plus preview URLs, for the console tab alone — an operator
 * deciding whether a just-uploaded logo looks right needs to SEE it, not
 * just know a key is set. Same `presignDownload` call `publicBrandingSnapshot`
 * makes, on the same operator-scoped row read rather than the cache, so a
 * preview is never stale immediately after a change.
 */
export async function getBrandingWithPreview(
  deps: { readonly storage: StorageProvider },
  operator: PlatformOperator,
): Promise<BrandingRowWithPreview> {
  const row = await getBranding(operator);
  return {
    ...row,
    logoUrl: row.logoKey === null ? null : await deps.storage.presignDownload(row.logoKey, 60 * 5),
    faviconUrl:
      row.faviconKey === null ? null : await deps.storage.presignDownload(row.faviconKey, 60 * 5),
  };
}

export async function setBranding(
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: {
    readonly productName?: string;
    readonly paletteId?: PaletteId;
  },
): Promise<BrandingRow> {
  const now = new Date();

  const fields = Object.keys(input).filter(
    (key) => input[key as keyof typeof input] !== undefined,
  ) as readonly ('productName' | 'paletteId')[];

  if (fields.length === 0) throw errors.validation({ productName: 'Nothing to change.' });

  await withPlatformAdminScope(async (tx) => {
    await tx
      .update(schema.branding)
      .set({
        ...(input.productName === undefined ? {} : { productName: input.productName }),
        ...(input.paletteId === undefined ? {} : { paletteId: input.paletteId }),
        updatedBy: operator.userId,
        updatedAt: now,
      })
      .where(eq(schema.branding.id, true));
  });

  await recordOperatorAction(operator.userId, 'branding.set', { ...input });

  await deps.events.publish([
    createEvent(
      brandingUpdated,
      { operatorUserId: operator.userId, fields: [...fields] },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return loadRow();
}

/**
 * Step 1 of a logo/favicon upload — issues a presigned PUT. Writes nothing;
 * see this file's header on why there is no row to reserve.
 */
async function presignAsset(
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly contentType: string; readonly sizeBytes: number },
  action: 'branding.presignLogo' | 'branding.presignFavicon',
): Promise<{
  readonly storageKey: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}> {
  if (input.contentType !== 'image/png') {
    throw errors.validation({ contentType: 'Only PNG images are accepted.' });
  }
  if (input.sizeBytes > MAX_LOGO_BYTES) {
    throw errors.validation({
      sizeBytes: `Files must be ${String(MAX_LOGO_BYTES)} bytes or smaller.`,
    });
  }

  const storageKey = newStorageKey(SYSTEM_ORG);

  await recordOperatorAction(operator.userId, action, null);

  const presigned = await deps.storage.presignUpload({
    key: storageKey,
    contentType: input.contentType,
    maxBytes: input.sizeBytes,
  });

  return {
    storageKey,
    url: presigned.url,
    headers: presigned.headers,
    expiresAt: presigned.expiresAt,
  };
}

/**
 * Step 2 — verify what actually landed, and only on a clean verdict, make it
 * the live logo/favicon. The previous key (if any) is deleted from storage
 * in the same call, best-effort — a failure to delete the OLD object must
 * not stop the NEW one from taking effect.
 */
async function confirmAsset(
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly storageKey: string },
  column: 'logoKey' | 'faviconKey',
  action: 'branding.confirmLogo' | 'branding.confirmFavicon',
  eventField: 'logoKey' | 'faviconKey',
): Promise<{ readonly status: 'clean' | 'infected' | 'rejected'; readonly reason?: string }> {
  const verdict = await verifyUpload(
    { storage: deps.storage, scanner: deps.scanner, maxBytes: MAX_LOGO_BYTES },
    { storageKey: input.storageKey, contentType: 'image/png' },
  );

  if (verdict.status !== 'clean') {
    await deps.storage.delete(input.storageKey).catch(() => undefined);
    await recordOperatorAction(operator.userId, action, { status: verdict.status });
    return {
      status: verdict.status,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    };
  }

  const now = new Date();
  const previousKey = await withPlatformAdminScope(async (tx) => {
    /* `FOR UPDATE` — without it, two confirms racing on this row (a network
       retry, two operators uploading close together) can both read the same
       previousKey before either commits, so the second writer deletes the
       FIRST writer's brand-new object instead of the one it actually
       replaced, orphaning it. The lock makes the second SELECT block until
       the first transaction commits, then read the value it actually left
       behind. */
    const rows = await tx.select().from(schema.branding).for('update').limit(1);
    const existing = rows[0]?.[column] ?? null;

    await tx
      .update(schema.branding)
      .set({ [column]: input.storageKey, updatedBy: operator.userId, updatedAt: now })
      .where(eq(schema.branding.id, true));

    return existing;
  });

  if (previousKey !== null && previousKey !== input.storageKey) {
    await deps.storage.delete(previousKey).catch(() => undefined);
  }

  await recordOperatorAction(operator.userId, action, { status: 'clean' });

  await deps.events.publish([
    createEvent(
      brandingUpdated,
      { operatorUserId: operator.userId, fields: [eventField] },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { status: 'clean' };
}

export const presignLogo = (
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly contentType: string; readonly sizeBytes: number },
) => presignAsset(deps, operator, input, 'branding.presignLogo');

export const confirmLogo = (
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly storageKey: string },
) => confirmAsset(deps, operator, input, 'logoKey', 'branding.confirmLogo', 'logoKey');

export const presignFavicon = (
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly contentType: string; readonly sizeBytes: number },
) => presignAsset(deps, operator, input, 'branding.presignFavicon');

export const confirmFavicon = (
  deps: BrandingDeps,
  operator: PlatformOperator,
  input: { readonly storageKey: string },
) => confirmAsset(deps, operator, input, 'faviconKey', 'branding.confirmFavicon', 'faviconKey');

export interface PublicBranding {
  readonly productName: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly paletteId: PaletteId;
}

/**
 * The unauthenticated snapshot — the login page and the public Docs page
 * call this before any session exists. Reads through `branding-cache.ts`'s
 * shared TTL cache, not `withPlatformAdminScope`: there is no operator here.
 *
 * The logo/favicon URLs are re-presigned on every call rather than cached
 * alongside the row — `presignDownload` is a local signature computation for
 * an S3-compatible client, not a network round trip, so this is cheap, and
 * it means a served URL is never stale by more than `ASSET_URL_TTL_SECONDS`.
 * A known limitation this trades for staying inside this system's existing
 * "storage is private" model rather than adding a public-bucket policy: an
 * email opened long after this window would show a broken logo image. Fine
 * for a first cut — most mail clients block remote images by default until
 * the reader allows them anyway — and named here rather than silently
 * shipped.
 */
export async function publicBrandingSnapshot(deps: {
  readonly storage: StorageProvider;
}): Promise<PublicBranding> {
  const snapshot: BrandingSnapshot = await getResolvedBranding();

  return {
    productName: snapshot.productName,
    logoUrl:
      snapshot.logoKey === null
        ? null
        : await deps.storage.presignDownload(snapshot.logoKey, ASSET_URL_TTL_SECONDS),
    faviconUrl:
      snapshot.faviconKey === null
        ? null
        : await deps.storage.presignDownload(snapshot.faviconKey, ASSET_URL_TTL_SECONDS),
    paletteId: snapshot.paletteId,
  };
}
