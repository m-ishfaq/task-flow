import { schema, withGlobalScope } from '@taskflow/db';
import { DEFAULT_PRODUCT_NAME, PALETTE_IDS } from '@taskflow/contracts';

export { DEFAULT_PRODUCT_NAME } from '@taskflow/contracts';

/**
 * The live branding snapshot (migration 0073), read the same way
 * `flag-evaluator.ts` reads flag overrides — off the request path, cached
 * with a short TTL and single-flight so a burst of requests shares one read.
 *
 * Every consumer that only ever READS branding (the public route the login
 * page and the Docs public page call, mail delivery, Docs PDF export) goes
 * through this module rather than `branding.service.ts`. That file is for
 * the Platform Admin console alone: an operator's own read/write always goes
 * through `withPlatformAdminScope` so it is audited and never stale, exactly
 * as `flags.service.ts`'s `listFlags` resolves from the row it just read,
 * never this cache.
 *
 * `withGlobalScope`, not `withPlatformAdminScope`: this cache is read by
 * code with no operator context at all — an unauthenticated tRPC call, a
 * mail-sending job, a PDF export — so it runs as the ordinary `taskflow_app`
 * role, which migration 0073 grants plain SELECT on `platform.branding`.
 */

export interface BrandingSnapshot {
  readonly productName: string;
  readonly logoKey: string | null;
  readonly faviconKey: string | null;
  /** One of the six preset palette ids, or `custom:<hue>` (0–360). */
  readonly paletteId: string;
  /** Migration 0096. NULL until an operator sets one. */
  readonly   salesEmail: string | null;
}

const CACHE_TTL_MS = 30_000;

let cached: { readonly at: number; readonly branding: BrandingSnapshot } | null = null;
let loading: Promise<BrandingSnapshot> | null = null;

const DEFAULT_SNAPSHOT: BrandingSnapshot = {
  productName: DEFAULT_PRODUCT_NAME,
  logoKey: null,
  faviconKey: null,
  paletteId: 'default',
  salesEmail: null,
};

const CUSTOM_PALETTE_RE = /^custom:(\d{1,3})$/;

/**
 * Narrows the row's `text` `palette_id` to a known value. Accepts any of
 * the six preset palette ids, or `custom:<hue>` where hue is 0–360.
 * Returns `'default'` for anything unrecognized.
 */
export function asPaletteId(value: string): string {
  if ((PALETTE_IDS as readonly string[]).includes(value)) return value;
  const match = CUSTOM_PALETTE_RE.exec(value);
  if (match !== null) {
    const hue = Number(match[1]);
    if (hue >= 0 && hue <= 360) return `custom:${String(hue)}`;
  }
  return 'default';
}

async function loadBranding(): Promise<BrandingSnapshot> {
  const rows = await withGlobalScope(async (tx) => tx.select().from(schema.branding).limit(1));

  /* The singleton is seeded by migration 0073 and never deleted, so this row
     is always present in practice. Falling back to the default snapshot
     rather than throwing keeps a consumer with no operator context (the
     public route, mail delivery) working even against a database state this
     code did not expect, the same "an error does not block" instinct
     `OrgGate` applies on the client. */
  const row = rows[0];
  if (!row) return DEFAULT_SNAPSHOT;

  return {
    productName: row.productName ?? DEFAULT_PRODUCT_NAME,
    logoKey: row.logoKey,
    faviconKey: row.faviconKey,
    paletteId: asPaletteId(row.paletteId),
    salesEmail: row.salesEmail,
  };
}

/** The current branding snapshot — cached with a short TTL and single-flight. */
export async function getResolvedBranding(): Promise<BrandingSnapshot> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.branding;

  loading ??= loadBranding().then((branding) => {
    cached = { at: Date.now(), branding };
    return branding;
  });
  try {
    return await loading;
  } finally {
    loading = null;
  }
}
