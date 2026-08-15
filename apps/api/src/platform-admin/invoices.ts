import { desc, inArray, schema, withPlatformAdminScope } from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';

export interface LastInvoiceRow {
  readonly status: string;
  readonly amountDueCents: number;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly hostedInvoiceUrl: string | null;
}

/**
 * The most recent recorded invoice per org, batched for a whole page.
 *
 * `DISTINCT ON` picks the newest row per org in a single pass rather than a
 * query per row — the same N+1 concern `org-directory.service.ts`'s own
 * header names for its owner join. Shared by the Billing tab
 * (`billing-directory.service.ts`) and the Organizations tab
 * (`org-directory.service.ts`), which both answer "did this customer
 * actually pay" from the same `identity.orgs` page.
 */
export async function fetchLastInvoices(
  orgIds: readonly OrgId[],
): Promise<Map<string, LastInvoiceRow>> {
  if (orgIds.length === 0) return new Map();

  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .selectDistinctOn([schema.invoices.orgId], {
        orgId: schema.invoices.orgId,
        status: schema.invoices.status,
        amountDueCents: schema.invoices.amountDueCents,
        currency: schema.invoices.currency,
        issuedAt: schema.invoices.issuedAt,
        hostedInvoiceUrl: schema.invoices.hostedInvoiceUrl,
      })
      .from(schema.invoices)
      .where(inArray(schema.invoices.orgId, orgIds))
      .orderBy(schema.invoices.orgId, desc(schema.invoices.issuedAt)),
  );

  /* `orgId` is stripped from the VALUE, not just absent from `LastInvoiceRow`'s
     declared type — the select above needs it to key the map, but the object
     then flows straight into a `.strict()` Zod output schema on both callers'
     routes, neither of which lists `orgId` as a `lastInvoice` field (it is
     already `row.orgId` one level up). Handing the raw select row through
     left it on the object at runtime regardless of what the TS interface
     promised, and `.strict()` rejects it: `orgId` is production's error, not
     a type this file merely described. */
  return new Map(rows.map(({ orgId, ...invoice }) => [orgId, invoice]));
}
