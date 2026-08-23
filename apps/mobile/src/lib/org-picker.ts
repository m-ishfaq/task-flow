/**
 * Pure logic for the org picker's create-organization form — ported from
 * `apps/web/src/features/org/org-picker-page.tsx`'s own `slugify`. No
 * `react-native` import, the same split every other feature's lib file
 * establishes.
 */

/** The slug follows the name until someone edits it by hand — a client-side
 *  convenience only. `tenancy.orgs.create`'s own `Slug` schema and its
 *  unique index are what actually decide; this just saves typing the
 *  common case. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
