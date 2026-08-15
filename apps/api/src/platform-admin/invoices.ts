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

  return new Map(rows.map((invoice) => [invoice.orgId, invoice]));
}
