import { z } from 'zod';

/**
 * The browser's configuration, validated once at module load.
 *
 * Same principle as apps/api/src/config/env.ts: a missing or malformed value
 * fails immediately and loudly rather than surfacing as `undefined` inside a
 * request handler. Here "immediately" means the app fails to start, which is the
 * correct outcome — a frontend pointed at the wrong API is not degraded, it is
 * wrong.
 *
 * Nothing secret is ever read here. See the note in env.d.ts: `import.meta.env`
 * is inlined into the bundle at build time.
 */
const Schema = z
  .object({
    /**
     * Absolute base URL of the API, or empty for same-origin.
     *
     * Empty is the default and the one that keeps the refresh cookie working: a
     * `SameSite=Strict` cookie is not attached to cross-site requests at all, so
     * pointing this at another origin breaks session renewal in a way that looks
     * like random sign-outs rather than a configuration error.
     */
    apiBaseUrl: z
      .string()
      .refine(
        (value) => value === '' || /^https?:\/\//.test(value),
        'VITE_API_BASE_URL must be an absolute http(s) URL, or empty for same-origin.',
      )
      // A trailing slash would produce `//trpc`, which some proxies normalize
      // and some route to a different backend entirely.
      .transform((value) => value.replace(/\/+$/, '')),
  })
  .strict();

export const config = Schema.parse({
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
});

export const TRPC_URL = `${config.apiBaseUrl}/trpc`;
