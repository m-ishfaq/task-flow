// `vitest/config` rather than `vite`, so the `test` block below is typed. With
// the plain vite export it is an unknown property and `tsc` rejects the file.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/* The repo-root .env — the same file apps/api, apps/realtime and apps/collab
   load at boot (each app's src/config/env.ts). Vite itself only surfaces
   `VITE_`-prefixed variables from .env files into `import.meta.env` and does
   NOT put the rest on `process.env`, so without this load the WEB_* variables
   below would only work when exported in the shell. `process.loadEnvFile`
   follows --env-file semantics: a variable already set on process.env wins,
   exactly like the server apps' own loader, so a shell export still beats the
   file. */
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const API_ORIGIN = process.env['WEB_API_ORIGIN'] ?? 'http://localhost:3000';

/**
 * `apps/realtime` (ai/phase-4-realtime.md §7.0) — its own process, its own
 * port, proxied for the identical reason `/trpc` is: the socket's `auth`
 * payload carries the access token rather than a cookie, so nothing here is
 * `SameSite`-fragile the way the refresh cookie is, but the gateway's own
 * handshake origin check (§3.2) validates `Origin` against `WEB_ORIGIN` —
 * simplest kept true in development by making that origin the same one too.
 */
const REALTIME_ORIGIN = process.env['WEB_REALTIME_ORIGIN'] ?? 'http://localhost:3001';

/**
 * `apps/collab` (ai/phase-6-docs.md §3.2) — the Hocuspocus gateway, a third
 * process on a third port, proxied for the identical reason `/socket.io` is:
 * its handshake also checks `Origin` against `WEB_ORIGIN`
 * (`apps/collab/src/auth.ts`'s `originAllowed`), so keeping the browser and
 * the gateway on one origin in development is what makes that check see the
 * same thing it sees in production.
 */
const COLLAB_ORIGIN = process.env['WEB_COLLAB_ORIGIN'] ?? 'http://localhost:3002';

/**
 * Hosts the dev server accepts besides localhost, for Vite's DNS-rebinding
 * defence (`server.allowedHosts`). Comma-separated; an entry starting with a
 * dot matches ANY subdomain, which is what covers ngrok's per-session random
 * URLs without an edit per run. Env-driven rather than hardcoded so switching
 * tunnel hosts — or adding a LAN IP when running `vite --host` — is a .env
 * edit, not a config edit. The default is the ngrok family; an explicit empty
 * value means "no extra hosts" (strict localhost-only). Listed in every
 * server's KNOWN_VARIABLES (apps/api, apps/realtime, apps/collab) so the
 * `WEB_` prefix does not trip their misspelling checks. The default is the
 * ngrok family — its TLDs have shifted before (.app, now .dev), so treat it
 * as a starting point and keep the set you actually use in WEB_ALLOWED_HOSTS.
 */
const ALLOWED_HOSTS = (
  process.env['WEB_ALLOWED_HOSTS'] ?? '.ngrok-free.app,.ngrok-free.dev,.ngrok.app,.ngrok.io'
)
  .split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

export default defineConfig({
  plugins: [react(), tailwindcss()],

  /* The workspace packages are TypeScript SOURCE, not built artifacts. Excluding
     them from dependency pre-bundling keeps Vite transforming them through the
     normal pipeline, so a change in packages/filter is picked up by HMR instead
     of being served from a stale optimized bundle. */
  optimizeDeps: {
    exclude: ['@taskflow/contracts', '@taskflow/filter', '@taskflow/policy', '@taskflow/ui'],
  },

  server: {
    port: 5173,

    /* Vite refuses any request whose Host header is not localhost — the
       DNS-rebinding defence, and the "Blocked request. This host is not
       allowed." 403 a phone gets when browsing through a tunnel such as
       ngrok, whose host is its own domain rather than localhost. The accepted
       hosts come from `WEB_ALLOWED_HOSTS` (see above); `true` (allow any
       host) is deliberately not supported, as that disables the check
       entirely and reopens the rebinding hole it exists to close. LAN-IP
       access via `vite --host` needs the address added to that variable too
       — but see the file header on the `__Host-` refresh cookie: only HTTPS
       or localhost is a secure context, which is why a TLS tunnel rather
       than a bare LAN IP is the supported path. */
    allowedHosts: ALLOWED_HOSTS,

    proxy: {
      '/trpc': {
        target: API_ORIGIN,
        changeOrigin: false,
      },
      '/socket.io': {
        target: REALTIME_ORIGIN,
        changeOrigin: false,
        ws: true,
      },
      '/collab': {
        target: COLLAB_ORIGIN,
        changeOrigin: false,
        ws: true,
      },
      /* Carrier webhooks (Phase 7 §3.11). These are plain Fastify routes on the
         API, not tRPC, and they are the one path where the CALLER is Twilio
         rather than this browser — so they only matter when a tunnel is
         pointed at this dev server, which is the usual setup because
         TELEPHONY_WEBHOOK_ORIGIN and WEB_ORIGIN want to be the same host.

         Without this, a tunnel aimed at :5173 answers 404 to every callback:
         Twilio cannot fetch the TwiML for an outbound call, so the call fails
         before it dials, and no status callback ever arrives to reconcile
         cost. `changeOrigin: false` matters more here than anywhere else in
         this block — the webhook signature is computed over the URL, so
         rewriting the Host would make every genuine request fail
         verification. */
      '/telephony': {
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
