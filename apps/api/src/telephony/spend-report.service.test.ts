import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { newId } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { spendReport } from './spend-report.service.js';

/**
 * Cost attribution reporting, against real Postgres (ai/phase-7-voice.md §5,
 * Wave 4).
 *
 * The property worth a real database for: `billedCents` sums
 * `COALESCE(actual, estimated)` PER ROW, not `SUM(actual)` over the group.
 * `spend-gate.test.ts`'s `readSpendState` suite already proves this for the
 * rolling-window total; this file proves the identical arithmetic survives
 * being grouped by `kind`, which a naive `SUM(actual_cents)` would silently
 * get wrong in a different way — reporting a fully-unreconciled kind as
 * exactly zero rather than absent from the report at all.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee50-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195ee50-0000-7000-8000-0000000000ff');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@telephony-report.test']];

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM comms.spend_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function ledgerRow(
  orgId: OrgId,
  kind: 'call' | 'sms' | 'number_purchase' | 'verification',
  estimatedCents: number,
  actualCents: number | null,
  daysAgo = 0,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.spendLedger).values({
      id: newId<'SpendLedgerId'>(),
      orgId,
      kind,
      estimatedCents,
      ...(actualCents === null ? {} : { actualCents }),
      occurredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    });
  });
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-report-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('spendReport', () => {
  it('groups by kind and reports both the estimate and the billed total', async () => {
    const orgId = await newOrg('report-basic');
    await ledgerRow(orgId, 'call', 100, 120);
    await ledgerRow(orgId, 'call', 100, 90);
    await ledgerRow(orgId, 'sms', 5, 5);

    const rows = await spendReport(orgId, { sinceDays: 30 });
    const byKind = new Map(rows.map((row) => [row.kind, row]));

    expect(byKind.get('call')).toEqual({ kind: 'call', count: 2, estimatedCents: 200, billedCents: 210 });
    expect(byKind.get('sms')).toEqual({ kind: 'sms', count: 1, estimatedCents: 5, billedCents: 5 });
  });

  it('falls back to the estimate for a row the carrier has not reconciled yet', async () => {
    /* The property that matters: an unreconciled row (actual = NULL) must
       count at its ESTIMATE, never as zero — the same reasoning
       `sumWithFallback`'s own comment gives for the rolling-window total. */
    const orgId = await newOrg('report-unreconciled');
    await ledgerRow(orgId, 'verification', 7, null);

    const rows = await spendReport(orgId, { sinceDays: 30 });

    expect(rows).toEqual([
      { kind: 'verification', count: 1, estimatedCents: 7, billedCents: 7 },
    ]);
  });

  it('excludes rows outside the window', async () => {
    const orgId = await newOrg('report-window');
    await ledgerRow(orgId, 'call', 100, 100, 0);
    await ledgerRow(orgId, 'call', 100, 100, 45);

    const rows = await spendReport(orgId, { sinceDays: 30 });

    expect(rows).toEqual([{ kind: 'call', count: 1, estimatedCents: 100, billedCents: 100 }]);
  });

  it("does not report another org's spend", async () => {
    const mine = await newOrg('report-tenant-mine');
    const theirs = await newOrg('report-tenant-theirs');
    await ledgerRow(mine, 'call', 100, 100);
    await ledgerRow(theirs, 'call', 999, 999);

    const rows = await spendReport(mine, { sinceDays: 30 });

    expect(rows).toEqual([{ kind: 'call', count: 1, estimatedCents: 100, billedCents: 100 }]);
  });

  it('reports nothing for an org with no ledger history', async () => {
    const orgId = await newOrg('report-empty');
    expect(await spendReport(orgId, { sinceDays: 30 })).toEqual([]);
  });
});
