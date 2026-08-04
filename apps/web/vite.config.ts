// `vitest/config` rather than `vite`, so the `test` block below is typed. With
// the plain vite export it is an unknown property and `tsc` rejects the file.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for apps/web (PLAN.md §4.1).
 *
 * ## Why the dev server proxies /trpc instead of enabling CORS on the API
 *
 * The refresh token cookie is `__Host-taskflow_refresh`, and every attribute in
 * its definition is load-bearing (apps/api/src/identity/cookies.ts):
 * `SameSite=Strict` is what makes CSRF against the refresh endpoint impossible
 * rather than merely mitigated, and the `__Host-` prefix requires `Secure` and
 * forbids a `Domain`.
 *
 * A browser at :5173 calling an API at :3000 is CROSS-SITE, so `SameSite=Strict`
 * means the cookie is never attached — refresh silently fails, and the obvious
 * "fix" is to weaken the cookie to `SameSite=None`, which removes the defence
 * for production too in order to make development convenient.
 *
 * Proxying makes the browser's origin and the API's origin the same one, so the
 * cookie behaves in development exactly as it does in production and nothing
 * about it has to be relaxed. `Secure` is satisfied because browsers treat
 * `http://localhost` as a secure context.
 *
 * The same reasoning applies to deployment: the API must be served from the same
 * site as the app (a path or a sibling subdomain behind one hostname), not a
 * third-party origin.
 */

const API_ORIGIN = process.env['WEB_API_ORIGIN'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  /* The workspace packages are TypeScript SOURCE, not built artifacts. Excluding
     them from dependency pre-bundling keeps Vite transforming them through the
     normal pipeline, so a change in packages/filter is picked up by HMR instead
     of being served from a stale optimized bundle. */
  optimizeDeps: {
    exclude: ['@taskflow/contracts', '@taskflow/filter', '@taskflow/policy'],
  },

  server: {
    port: 5173,
    proxy: {
      '/trpc': {
        target: API_ORIGIN,
        changeOrigin: false,
      },
    },
  },

  build: {
    /* Source maps are how a Sentry stack trace from production names a line of
       our code rather than a column in a minified chunk. */
    sourcemap: true,
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/testing/setup.ts'],
    css: false,
  },
});
