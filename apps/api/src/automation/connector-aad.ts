/**
 * The AAD binding a connector credential to its org and row.
 *
 * A ciphertext stolen out of the database cannot be transplanted into
 * another org's row — the AAD (and the data key's own `{ orgId }`
 * encryption context) would refuse to decrypt there.
 *
 * Its own file, separate from `integration.service.ts` where it used to
 * live, so `token-refresh.ts` can use the identical AAD without creating an
 * import cycle: `token-refresh.ts` already imports types FROM
 * `integration.service.ts`, and `import-x/no-cycle` (packages/config/
 * eslint/base.js) refuses a module importing back into one that imports it.
 * `integration.service.ts` re-exports this under its own original name, so
 * every existing caller (`integration-webhooks.ts` among them) needs no
 * change at all.
 */
export function integrationTokenAad(orgId: string, integrationId: string): string {
  return `integration-token:${orgId}:${integrationId}`;
}
