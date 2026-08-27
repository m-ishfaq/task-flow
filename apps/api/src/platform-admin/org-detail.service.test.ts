import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import { getOrgDetail } from './org-detail.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * `getOrgDetail`'s `hasPushDevice` field (migration-free — reused grants,
 * see this function's own header on why it reads `platform.push_subscriptions`/
 * `platform.expo_push_tokens` as `taskflow_audit` rather than taking a new
 * grant for `taskflow_platform_admin`).
 *
 * `getOrgDetail` itself has no other direct test in this directory — its
 * other fields (entitlements, spend, invoices) are exercised indirectly
 * through the router suite's error-path tests. This file is scoped to the
 * one behavior this session added: does the member list correctly report
 * who has at least one registered push device, across BOTH channels, and
 * across the ones who have neither.
 */

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000d1');
const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000df');
const operator: PlatformOperator = { userId: OPERATOR, requestId };

const ORG = unsafeAsId<'OrgId'>('0195dd00-0000-7000-8000-0000000000d2');
const WEB_MEMBER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000d3');
const EXPO_MEMBER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000d4');
const NO_DEVICE_MEMBER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000d5');

let admin: AdminConnection;

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-org-detail-svc' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-org-detail-audit' });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-org-detail-admin',
  });
});

beforeEach(async () => {
  await admin.setOrg(null);

  /* Children before parents — this suite's own previous run, or a
     neighbour's, may leave rows referencing these ids.

     Each DELETE runs under the scope its table's RLS keys on. The migrator
     does not bypass RLS, so a delete under the wrong scope matches ZERO rows
     and removes nothing, silently — which is what left the org behind and
     collided the next insert on `orgs_pkey`. */
  for (const userId of [WEB_MEMBER, EXPO_MEMBER, NO_DEVICE_MEMBER]) {
    await admin.setUser(userId);
    await admin.query(`DELETE FROM platform.push_subscriptions WHERE user_id = $1`, [userId]);
    await admin.query(`DELETE FROM platform.expo_push_tokens WHERE user_id = $1`, [userId]);
  }

  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OPERATOR]);

  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1)`, [
    [OPERATOR, WEB_MEMBER, EXPO_MEMBER, NO_DEVICE_MEMBER],
  ]);

  for (const [id, email] of [
    [OPERATOR, 'org-detail-operator@platform.test'],
    [WEB_MEMBER, 'org-detail-web@platform.test'],
    [EXPO_MEMBER, 'org-detail-expo@platform.test'],
    [NO_DEVICE_MEMBER, 'org-detail-none@platform.test'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  /* orgs RLS keys on app.org_id (migration 0004) and the migrator does NOT
     bypass it, so an org row can only be inserted under a scope naming its own
     id — the pattern `wave2.sweep.test.ts` already documents and follows.
     Without this the INSERT is refused and every test in this file fails in
     setup. */
  await admin.setOrg(ORG);
  await admin.query(
    `INSERT INTO identity.orgs (id, name, slug, status) VALUES ($1, 'Org Detail Test Org', 'org-detail-test-org', 'active')`,
    [ORG],
  );

  for (const [userId, role] of [
    [WEB_MEMBER, 'member'],
    [EXPO_MEMBER, 'member'],
    [NO_DEVICE_MEMBER, 'member'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'active')`,
      [ORG, userId, role],
    );
  }

  /* Both tables are self-scoped on app.user_id (0029, 0082), so each row is
     written under its own owner's scope — the migrator does not bypass it. */
  await admin.setUser(WEB_MEMBER);
  await admin.query(
    `INSERT INTO platform.push_subscriptions (id, user_id, endpoint, p256dh, auth)
     VALUES (gen_random_uuid(), $1, 'https://push.example/endpoint', 'p256dh-key', 'auth-secret')`,
    [WEB_MEMBER],
  );
  await admin.setUser(EXPO_MEMBER);
  await admin.query(
    `INSERT INTO platform.expo_push_tokens (id, user_id, expo_push_token)
     VALUES (gen_random_uuid(), $1, 'ExponentPushToken[test-token]')`,
    [EXPO_MEMBER],
  );
  /* NO_DEVICE_MEMBER gets neither — the negative case. */
});

afterAll(async () => {
  await closeDatabase();
});

describe('getOrgDetail — hasPushDevice', () => {
  it('reports a registered web subscription, a registered Expo token, and neither, correctly per member', async () => {
    const detail = await getOrgDetail(operator, ORG);
    const byId = new Map(detail.members.map((member) => [member.userId, member]));

    expect(byId.get(WEB_MEMBER)?.hasPushDevice).toBe(true);
    expect(byId.get(EXPO_MEMBER)?.hasPushDevice).toBe(true);
    expect(byId.get(NO_DEVICE_MEMBER)?.hasPushDevice).toBe(false);
  });
});
