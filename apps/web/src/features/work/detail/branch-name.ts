/**
 * The client-side mirror of `automation/branch.service.ts`'s own `slugify`/
 * default-name computation (ai/phase-15-ai-copilot-and-permissions.md §7.2)
 * — duplicated locally rather than imported across the `apps/api`/`apps/web`
 * boundary this codebase does not otherwise cross (the identical trade
 * `apps/mobile/src/lib/org-picker.ts`'s own `slugify` already accepts).
 *
 * Used ONLY to render a live preview of what a branch name will actually
 * become — the server re-runs the identical normalization on whatever text
 * it receives and never trusts this computation, so drift here is a UI
 * cosmetic bug, never a correctness one.
 */

const MAX_SLUG_LENGTH = 50;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/** `<reference>-<slug>` — e.g. `web-142-fix-login-redirect`. */
export function defaultBranchName(reference: string, title: string): string {
  return `${slugify(reference)}-${slugify(title)}`.replace(/-+$/, '');
}

/** What the server will actually create if `raw` is submitted as-is,
    falling back to the deterministic default on an edit that slugifies to
    nothing (clearing the field, or typing only punctuation). */
export function normalizedBranchName(raw: string, reference: string, title: string): string {
  const normalized = slugify(raw).replace(/-+$/, '');
  return normalized === '' ? defaultBranchName(reference, title) : normalized;
}
