import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicBrandingQuery } from '../../lib/branding.js';
import { paletteColorsOf } from '../../lib/branding-palettes.js';
import { BrandingContext, DEFAULT_BRANDING } from '../../lib/branding-context.js';

/**
 * Resolves the deployment's branding (migration 0073) and applies it —
 * document title, favicon, accent palette — everywhere in one place.
 *
 * ## Why this never blocks
 *
 * Unlike `OrgGate`, which holds the router behind a spinner until its check
 * settles, this renders `children` immediately, on every render, with
 * `DEFAULT_BRANDING` until the query resolves. `OrgGate` blocks because a
 * stale org id produces a page full of NOT_A_MEMBER errors if it races the
 * request it's guarding — a correctness problem. Branding is cosmetic: the
 * worst outcome of racing it is one frame of the stock wordmark before the
 * real one swaps in, which is also exactly what an unreachable API leaves
 * showing forever. Blocking the whole app on that trade would be wrong in
 * both directions.
 *
 * Mounted unconditionally in `app.tsx`, outside `OrgGate` and even before a
 * session exists — the same reasoning `auth.oauth.providers` documents for
 * firing pre-auth, since the login page needs the real product name and logo
 * too.
 */
export function BrandingProvider({ children }: { readonly children: ReactNode }) {
  const query = useQuery(publicBrandingQuery());
  const branding = query.data ?? DEFAULT_BRANDING;

  useEffect(() => {
    document.title = branding.productName;
  }, [branding.productName]);

  useEffect(() => {
    const colors = paletteColorsOf(branding.paletteId);
    const root = document.documentElement.style;
    /* Overrides `styles.css`'s `@theme` values, which compile to plain custom
       properties on `:root` — an inline style on the root element always wins
       over a stylesheet rule at the same specificity, so this one write is
       what makes every existing `bg-accent`/`text-accent`/`border-accent`
       utility repaint with no per-component change. */
    root.setProperty('--color-accent', colors.base);
    root.setProperty('--color-accent-hover', colors.hover);
    root.setProperty('--color-accent-ink', colors.ink);
  }, [branding.paletteId]);

  useEffect(() => {
    /* `index.html` ships no `<link rel="icon">` at all today, so there is
       nothing to remove when this is null — the browser falls back to its
       own default, same as before this feature existed. */
    if (branding.faviconUrl === null) return;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      document.head.appendChild(link);
    }
    link.href = branding.faviconUrl;
  }, [branding.faviconUrl]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}
