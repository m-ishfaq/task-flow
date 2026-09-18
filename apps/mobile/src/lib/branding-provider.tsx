import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicBrandingQuery } from './branding.js';
import { BrandingContext, DEFAULT_BRANDING, type BrandingValue } from './branding-context.js';

/**
 * Resolves the deployment's branding (migration 0073) and makes it
 * available everywhere via `useBranding()` — ported from
 * `apps/web/src/features/branding/branding-provider.tsx`.
 *
 * ## Why this never blocks
 *
 * Renders `children` immediately, on every render, with `DEFAULT_BRANDING`
 * until the query resolves — the same reasoning web's own provider gives:
 * branding is cosmetic, so the worst case of racing it is one frame of the
 * stock name before the real one swaps in, which is also exactly what an
 * unreachable API leaves showing forever. This app's own `session.restore()`
 * gate in `app/_layout.tsx` blocks on something that would be a genuine
 * correctness problem if raced (a stale org id); nothing here rises to that.
 *
 * Mounted unconditionally in `app/_layout.tsx`, inside `QueryClientProvider`
 * but OUTSIDE the unlock-state/session gates — the sign-in screen and the
 * lock screen both need the real product name too, the same reason web
 * mounts its provider before any session exists.
 *
 * Unlike web's provider, there is no `useEffect` here at all: web imperatively
 * mutates `document.title` and a `<link rel="icon">` element because those are
 * DOM singletons outside React's own tree. Nothing on this platform has an
 * equivalent — every screen that wants the product name or logo reads
 * `useBranding()` and renders it as ordinary JSX, so a plain context provider
 * is the whole implementation.
 */
export function BrandingProvider({ children }: { readonly children: ReactNode }) {
  const query = useQuery(publicBrandingQuery());
  const branding: BrandingValue = {
    ...(query.data ?? DEFAULT_BRANDING),
    isPending: query.isPending,
  };

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}
