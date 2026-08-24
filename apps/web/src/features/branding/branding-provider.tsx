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
    /* When no custom favicon is uploaded, render the SVG flow-mark as a
       data URI so the browser always shows something on-brand rather than
       its generic page icon. Hex colors are used instead of OKLCH because
       the data URI is rendered in the browser's favicon context, where
       OKLCH support is inconsistent (Safari < 16.4, older Chromium).
       `#9333ea` is the default accent; other palettes get their base
       color converted via an offscreen canvas. */
    const colors = paletteColorsOf(branding.paletteId);
    /* Convert OKLCH to hex using the canvas — the only reliable cross-
       browser way without importing a color-space library. */
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.fillStyle = colors.base;
    const hex = ctx.fillStyle; // canvas always returns #rrggbb

    const svgFavicon =
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'>` +
        `<path d='M8 12C8 12 12 8 16 12C20 16 24 12 24 12' stroke='${hex}' stroke-width='2.5' stroke-linecap='round' opacity='0.5'/>` +
        `<path d='M8 20C8 20 12 16 16 20C20 24 24 20 24 20' stroke='${hex}' stroke-width='2.5' stroke-linecap='round' opacity='0.3'/>` +
        `<circle cx='8' cy='16' r='3.5' fill='${hex}' opacity='0.9'/>` +
        `<circle cx='16' cy='16' r='4.5' fill='${hex}'/>` +
        `<circle cx='24' cy='16' r='5.5' fill='${hex}' opacity='0.85'/>` +
        `<circle cx='24' cy='16' r='5.5' fill='white' opacity='0.15'/>` +
        `</svg>`,
      )}`;

    const href = branding.faviconUrl ?? svgFavicon;
    const type = branding.faviconUrl !== null ? 'image/png' : 'image/svg+xml';

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = type;
    link.href = href;
  }, [branding.faviconUrl, branding.paletteId]);

  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}
