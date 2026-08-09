import { eq } from 'drizzle-orm';
import { withGlobalScope } from './client.js';
import type { OrgId } from './client.js';
import { subaccountOrgs } from './schema/comms.js';

/**
 * The carrier-SID → org lookup an inbound webhook needs before it has a scope
 * (ai/phase-7-voice.md §3.11; migration 0032's own header).
 *
 * ## Why this lives in packages/db rather than in apps/api
 *
 * It is the same reason `audit-log.ts`, `docs-backlinks.ts`, and the outbox
 * claim live here: `withGlobalScope` is lint-restricted to the identity module
 * and to this package, because a query written against a TENANT table inside it
 * silently returns nothing — which reads as "no data" rather than "wrong
 * scope". Rather than widen that guardrail to cover a telephony module, the one
 * query that genuinely has no org yet lives behind a named function in the data
 * layer, where it can be read in one sitting.
 *
 * ## What this can and cannot see
 *
 * `comms.subaccount_orgs` carries a carrier SID and an org id and nothing else,
 * and has no RLS by design — which is precisely why a global-scope read of it
 * works at all, and why it is safe that it does. The auth token, the spend
 * figures, and every phone number live in RLS'd tables that this scope reads as
 * empty.
 *
 * ## The caller's obligation
 *
 * The org this returns is derived from an **unverified** payload — the
 * AccountSid field of a webhook whose signature has not been checked yet, since
 * checking it requires the token this lookup is the first step toward. So the
 * org id returned here selects WHICH KEY to verify against; it is not a claim
 * that the request is legitimate, and nothing may be written under it until
 * `verifyTwilioSignature` has passed. That ordering is the whole control: a
 * caller that writes first and verifies second has verified nothing.
 */
export async function resolveOrgBySubaccountSid(subaccountSid: string): Promise<OrgId | undefined> {
  if (subaccountSid.length === 0) return undefined;

  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({ orgId: subaccountOrgs.orgId })
      .from(subaccountOrgs)
      .where(eq(subaccountOrgs.subaccountSid, subaccountSid))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : (row.orgId as OrgId);
  });
}
