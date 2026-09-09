import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { closeDatabase, initializeDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { newId, SoftwareKeyProvider } from '@taskflow/security';
import * as orgs from '../tenancy/org.service.js';
import { TEST_ENV } from '../testing/fixtures.js';
import {
  aiSpendReport,
  clearOrgProviderOverride,
  createProviderConfig,
  getOrgProviderOverride,
  listProviderConfigs,
  rotateProviderConfigKey,
  setDefaultProviderConfig,
  setOrgProviderOverride,
} from './provider-config.service.js';
import { costCentsFor } from './rates.js';
import { resolveAiProvider } from './provider-resolver.js';
import type { PlatformOperator } from '../platform-admin/org-directory.service.js';

/**
 * The AI provider catalog and org overrides, against real Postgres (§2.3).
 *
 * `listProviderConfigs` is the one assertion that matters most here: the
 * view type it returns has no field an encrypted key could travel through,
 * and this is proven by reading the ACTUAL keys returned, not by trusting
 * the type — a route that accidentally spread the raw row would still
 * typecheck against a looser return type.
 */

const MASTER_KEY_ID = 'test-master';
function newKeys(): SoftwareKeyProvider {
  return new SoftwareKeyProvider({
    currentMasterKeyId: MASTER_KEY_ID,
    masterKeys: [{ id: MASTER_KEY_ID, key: new Uint8Array(32).fill(7) }],
  });
}

const OPERATOR = unsafeAsId<'UserId'>('0195f200-0000-7000-8000-000000000001');
const OWNER = unsafeAsId<'UserId'>('0195f200-0000-7000-8000-000000000002');
const requestId = unsafeAsId<'RequestId'>('0195f200-0000-7000-8000-0000000000ff');

function operatorOf(userId: UserId): PlatformOperator {
  return { userId, requestId };
}

let admin: AdminConnection;
const created: OrgId[] = [];
const createdConfigIds: string[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OPERATOR, OWNER]]);
  for (const [id, email] of [
    [OPERATOR, 'operator@ai-provider-config.test'],
    [OWNER, 'owner@ai-provider-config.test'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-provider-config-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'ai-provider-config-platform-admin-test',
  });
});

afterAll(async () => {
  for (const orgId of created) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.ai_org_overrides WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  if (createdConfigIds.length > 0) {
    await admin.query(`DELETE FROM platform.ai_provider_config WHERE id = ANY($1::uuid[])`, [
      createdConfigIds,
    ]);
  }
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OPERATOR]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OPERATOR, OWNER]]);
  await admin.end();
  await closeDatabase();
});

describe('createProviderConfig / listProviderConfigs', () => {
  it('never returns the key, and it decrypts back to what was stored', async () => {
    const keys = newKeys();
    const events = new RecordingEventBus();

    const created1 = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-real-secret-value',
      label: 'Default Sonnet',
      isDefault: true,
    });
    createdConfigIds.push(created1.id);

    expect(Object.keys(created1)).not.toContain('apiKeyCiphertext');
    expect(JSON.stringify(created1)).not.toContain('sk-ant-real-secret-value');

    const list = await listProviderConfigs(operatorOf(OPERATOR));
    const row = list.find((entry) => entry.id === created1.id);
    expect(row).toBeDefined();
    expect(row?.isDefault).toBe(true);
    expect(JSON.stringify(list)).not.toContain('sk-ant-real-secret-value');

    // The write actually round-trips through the real KeyProvider + AAD.
    const orgId = await newOrg('ai-config-resolve');
    const resolved = await resolveAiProvider(orgId, keys);
    expect(resolved.providerName).toBe('anthropic');
    expect(resolved.model).toBe('claude-sonnet-4');
  });

  it('setDefault clears the previous default (the partial unique index holds)', async () => {
    const keys = newKeys();
    const events = new RecordingEventBus();

    const first = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-haiku-4',
      apiKey: 'sk-ant-first',
      label: 'First',
      isDefault: true,
    });
    createdConfigIds.push(first.id);

    const second = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-opus-4',
      apiKey: 'sk-ant-second',
      label: 'Second',
      isDefault: false,
    });
    createdConfigIds.push(second.id);

    const promoted = await setDefaultProviderConfig({ events }, operatorOf(OPERATOR), second.id);
    expect(promoted.isDefault).toBe(true);

    const list = await listProviderConfigs(operatorOf(OPERATOR));
    const defaults = list.filter((row) => row.isDefault && createdConfigIds.includes(row.id));
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(second.id);
  });

  it('rotateProviderConfigKey re-encrypts under a fresh data key', async () => {
    const keys = newKeys();
    const events = new RecordingEventBus();

    const config = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-before-rotation',
      label: 'Rotate me',
      isDefault: false,
    });
    createdConfigIds.push(config.id);

    await rotateProviderConfigKey(
      { events },
      keys,
      operatorOf(OPERATOR),
      config.id,
      'sk-ant-after-rotation',
    );

    const orgId = await newOrg('ai-config-rotate');
    await setOrgProviderOverride({ events }, operatorOf(OPERATOR), orgId, config.id);
    const resolved = await resolveAiProvider(orgId, keys);
    expect(resolved.providerName).toBe('anthropic');
  });
});

describe('org overrides', () => {
  it('an org override wins over the global default', async () => {
    const keys = newKeys();
    const events = new RecordingEventBus();

    const defaultConfig = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-haiku-4',
      apiKey: 'sk-ant-global-default',
      label: 'Global default',
      isDefault: true,
    });
    createdConfigIds.push(defaultConfig.id);

    const overrideConfig = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-opus-4',
      apiKey: 'sk-ant-org-override',
      label: 'Org override',
      isDefault: false,
    });
    createdConfigIds.push(overrideConfig.id);

    const orgId = await newOrg('ai-config-override');

    const beforeOverride = await resolveAiProvider(orgId, keys);
    expect(beforeOverride.model).toBe('claude-haiku-4');

    await setOrgProviderOverride({ events }, operatorOf(OPERATOR), orgId, overrideConfig.id);
    const afterOverride = await resolveAiProvider(orgId, keys);
    expect(afterOverride.model).toBe('claude-opus-4');

    await clearOrgProviderOverride({ events }, operatorOf(OPERATOR), orgId);
    const afterClear = await resolveAiProvider(orgId, keys);
    expect(afterClear.model).toBe('claude-haiku-4');
  });

  it('getOrgProviderOverride reads back exactly what set/clear wrote — the console has no other way to see it', async () => {
    const keys = newKeys();
    const events = new RecordingEventBus();

    const config = await createProviderConfig({ events }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-opus-4',
      apiKey: 'sk-ant-get-override',
      label: 'Get override',
      isDefault: false,
    });
    createdConfigIds.push(config.id);

    const orgId = await newOrg('ai-config-get-override');

    expect(await getOrgProviderOverride(operatorOf(OPERATOR), orgId)).toBeUndefined();

    await setOrgProviderOverride({ events }, operatorOf(OPERATOR), orgId, config.id);
    expect(await getOrgProviderOverride(operatorOf(OPERATOR), orgId)).toBe(config.id);

    await clearOrgProviderOverride({ events }, operatorOf(OPERATOR), orgId);
    expect(await getOrgProviderOverride(operatorOf(OPERATOR), orgId)).toBeUndefined();
  });
});

describe('aiSpendReport', () => {
  it('joins the org name and slug, and reports the token totals and rate the cost was computed from', async () => {
    const orgId = await newOrg('ai-spend-report');
    const inputTokens = 40_000;
    const outputTokens = 8_000;
    const costCents = costCentsFor('claude-haiku-4', { inputTokens, outputTokens });

    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO ai.usage_ledger
         (id, org_id, feature, provider, model, input_tokens, output_tokens, cost_cents)
       VALUES ($1, $2, 'standup', 'anthropic', 'claude-haiku-4', $3, $4, $5)`,
      [newId<'AiUsageLedgerId'>(), orgId, inputTokens, outputTokens, costCents],
    );
    await admin.setOrg(null);

    const report = await aiSpendReport(operatorOf(OPERATOR), { sinceDays: 30 });
    const row = report.find((entry) => entry.orgId === orgId);

    expect(row).toEqual({
      orgId,
      orgName: `Org ai-spend-report`,
      orgSlug: 'ai-spend-report',
      model: 'claude-haiku-4',
      totalCents: costCents,
      calls: 1,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      rate: { inputCentsPerMillion: 80, outputCentsPerMillion: 400 },
    });
  });
});
