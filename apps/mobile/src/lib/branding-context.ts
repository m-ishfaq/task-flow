import { createContext, useContext } from 'react';
import { paletteColorsOf, type PaletteColors } from '@taskflow/tokens';

/**
 * The branding context, separated from the provider that fills it — same
 * split, same reason, as `apps/web/src/lib/branding-context.ts`: a module
 * exporting both a component and a hook remounts wholesale on every save.
 * See `branding-provider.tsx` for the provider itself.
 *
 * No `faviconUrl` here, unlike web's `BrandingValue` — nothing on this
 * platform has a browser tab to put one in. The native app icon/name shown
 * on the home screen are baked into the binary at build time
 * (`app.config.ts`'s `icon`/`name`) and cannot be changed by anything this
 * context does — that is an OS constraint, not a gap this file works around.
 * What CAN be dynamic, and is: the product name and logo shown INSIDE the
 * app's own screens, and the accent palette applied to the UI you're
 * looking at right now.
 */

export interface BrandingValue {
  readonly productName: string;
  readonly logoUrl: string | null;
  readonly paletteId: string;
  /** True while the first branding fetch is in-flight — lets BrandMark suppress the fallback initial to avoid a flash. */
  readonly isPending: boolean;
}

/**
 * What every screen shows before the first `branding.public` response
 * arrives, and what an unreachable API leaves it showing forever. Matches
 * `app.config.ts`'s static `name: 'Rinavai'` and `branding-cache.ts`'s own
 * `DEFAULT_SNAPSHOT` on the server, so a deployment that never touches
 * branding — or one the network can't reach right now — renders exactly
 * what it always rendered before this feature existed.
 */
export const DEFAULT_BRANDING: BrandingValue = {
  productName: 'Rinavai',
  logoUrl: null,
  paletteId: 'default',
  isPending: false,
};

/**
 * Defaults to `DEFAULT_BRANDING` rather than `null` — branding is cosmetic,
 * the same "never blocks" argument `branding-provider.tsx` makes, one layer
 * further out. A screen rendered in a test with no `BrandingProvider` sees
 * the stock name and palette rather than crashing on render.
 */
export const BrandingContext = createContext<BrandingValue>(DEFAULT_BRANDING);

export function useBranding(): BrandingValue {
  return useContext(BrandingContext);
}

/** The current deployment's resolved accent colors — `useBranding().paletteId` fed straight through `@taskflow/tokens`' own lookup. */
export function usePaletteColors(): PaletteColors {
  const { paletteId } = useBranding();
  return paletteColorsOf(paletteId);
}
