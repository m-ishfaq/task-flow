import { createContext, useContext } from 'react';
import type { PaletteId } from '@taskflow/contracts';

/**
 * The branding context, separated from the provider that fills it.
 *
 * Split for `react-refresh/only-export-components`, the same reason
 * `toast-context.ts` gives: a module exporting both a component and a hook
 * remounts wholesale on every save, dropping whatever state the app was
 * holding. See `features/branding/branding-provider.tsx` for the provider
 * itself and why it never blocks render.
 */

export interface BrandingValue {
  readonly productName: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly paletteId: PaletteId;
}

/**
 * What every surface shows before the first `branding.public` response
 * arrives, and what a broken or unreachable API leaves it showing forever.
 * Matches `index.html`'s static `<title>` and `branding-cache.ts`'s own
 * `DEFAULT_SNAPSHOT` on the server, so a deployment that never touches
 * branding — or one the network can't reach right now — renders exactly what
 * it always rendered before this feature existed.
 */
export const DEFAULT_BRANDING: BrandingValue = {
  productName: 'TaskFlow',
  logoUrl: null,
  faviconUrl: null,
  paletteId: 'default',
};

/**
 * Defaults to `DEFAULT_BRANDING` rather than `null`, unlike `ToastContext`.
 * `useToast` throws with no provider because a swallowed rollback message is
 * a real bug to catch loudly. Branding is cosmetic — a component rendered in
 * a test harness with no `BrandingProvider` (most of this app's component
 * tests, which wrap only `QueryClientProvider`) should see the stock name and
 * palette, not crash on render. It is the same "never blocks" argument the
 * provider itself makes, one layer further out.
 */
export const BrandingContext = createContext<BrandingValue>(DEFAULT_BRANDING);

export function useBranding(): BrandingValue {
  return useContext(BrandingContext);
}
