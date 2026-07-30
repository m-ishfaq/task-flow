/// <reference types="vite/client" />

/**
 * Build-time configuration reaching the browser.
 *
 * The workspace rule is that env vars come from a validated Zod schema and never
 * from `process.env` (CLAUDE.md rule 3, enforced by the `bareEnv` ban in
 * packages/config/eslint/security.js). In a browser bundle the rule has a second
 * half that matters more: `import.meta.env` values are INLINED INTO THE SHIPPED
 * JAVASCRIPT at build time. Anything named here is public, permanently, to
 * anyone who opens devtools.
 *
 * So this interface is deliberately almost empty, and stays that way. A secret
 * cannot be given to the browser safely — not behind a flag, not "only in
 * staging". If the frontend appears to need one, the operation belongs on the
 * API. `src/lib/config.ts` is where these are read and validated.
 */
interface ImportMetaEnv {
  /**
   * Where the tRPC endpoint lives, defaulting to the same origin.
   *
   * Same-origin is not a convenience default. The refresh cookie is
   * `SameSite=Strict`, so it is simply not sent on a cross-site request — see
   * the header comment in vite.config.ts.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
