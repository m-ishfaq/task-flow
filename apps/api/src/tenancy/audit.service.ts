import { readAuditChain, readAuditEntries, type AuditEntryRow } from '@taskflow/db';
import { verifyAuditChain, type ChainVerification } from '@taskflow/security';
import type { OrgId } from '@taskflow/contracts';

/**
 * Reading the audit log (PLAN.md §8.6).
 *
 * Read-only by construction rather than by convention: the application role
 * holds SELECT on audit.audit_log and nothing else, so there is no INSERT for
 * this file to be tempted into. Entries are written by `audit.projection.ts`,
 * running as taskflow_audit.
 *
 * Thin on purpose. The queries live in @taskflow/db because the verification
 * SELECT list is part of the hash contract with @taskflow/security and belongs
 * beside the migration defining the trigger it mirrors.
 */

export type AuditEntry = AuditEntryRow;

export interface ListAuditInput {
  readonly limit: number;
  readonly before: string | null;
}

export async function listAuditEntries(
  orgId: OrgId,
  input: ListAuditInput,
): Promise<readonly AuditEntry[]> {
  return readAuditEntries(orgId, input);
}

/**
 * Recomputes the org's hash chain and reports every break.
 *
 * Reads the whole chain in one query, deliberately: verification is an
 * on-demand admin action rather than a hot path, and a partial verification
 * starting mid-chain cannot distinguish "intact from here" from "the missing
 * prefix was removed". Chunked verification needs a signed checkpoint, which
 * belongs with the daily export to immutable storage (§8.6).
 */
export async function verifyAuditLog(orgId: OrgId): Promise<ChainVerification> {
  return verifyAuditChain(await readAuditChain(orgId));
}
