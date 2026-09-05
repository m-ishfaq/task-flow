import {
  countRows,
  desc,
  eq,
  gte,
  schema,
  sumColumn,
  withOrgScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type KeyProvider, type OrgId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { encryptString, identityFieldAad, newId } from '@taskflow/security';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { recordOperatorAction } from '../platform-admin/audit.js';
import type { PlatformOperator } from '../platform-admin/org-directory.service.js';
import {
  aiOrgOverrideCleared,
  aiOrgOverrideSet,
  aiProviderConfigCreated,
  aiProviderConfigDefaultChanged,
  aiProviderConfigKeyRotated,
} from './events.js';

export interface AiProviderConfigDeps {
  readonly events: EventBus;
}

/**
 * The AI provider catalog and its per-org overrides (§2.3) — the
 * platform-admin console's "AI Models" tab, and the write half of
 * `provider-resolver.ts`'s read.
 *
 * Every write goes through `withPlatformAdminScope`, the identical split
 * `flags.service.ts` uses for `platform.flag_overrides`: `taskflow_app` also
 * holds a grant on these tables (so the ordinary request pool can resolve a
 * provider without a second connection), but only the console — running as
 * `taskflow_platform_admin`, with a real operator-audit row per action — may
 * change the catalog or an org's override.
 */

function apiKeyAad(providerConfigId: string): string {
  return identityFieldAad({
    table: 'platform.ai_provider_config',
    column: 'api_key_ciphertext',
    rowId: providerConfigId,
  });
}

export interface ProviderConfigView {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function viewOf(row: typeof schema.aiProviderConfig.$inferSelect): ProviderConfigView {
  /* The key never leaves this file — not `apiKeyCiphertext`, not
     `dataKeyWrapped`, nothing that could be worked backward toward it. A
     view type that omitted the field by convention would still let a future
     edit spread the row into a route's output; a NAMED type without the
     field cannot. */
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    label: row.label,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProviderConfigs(
  operator: PlatformOperator,
): Promise<readonly ProviderConfigView[]> {
  const rows = await withPlatformAdminScope(async (tx) =>
    tx.select().from(schema.aiProviderConfig).orderBy(desc(schema.aiProviderConfig.createdAt)),
  );

  await recordOperatorAction(operator.userId, 'ai.providers.list', null);

  return rows.map(viewOf);
}

export interface CreateProviderConfigInput {
  readonly provider: 'anthropic';
  readonly model: string;
  readonly apiKey: string;
  readonly label: string;
  readonly isDefault: boolean;
}

/**
 * Adds one model to the catalog, encrypting `apiKey` under a FRESH data key
 * — never reusing another row's, the same "one wrapped key per row" shape
 * `comms.subaccounts` uses, so retiring one config's key can never affect
 * another's.
 */
export async function createProviderConfig(
  deps: AiProviderConfigDeps,
  keys: KeyProvider,
  operator: PlatformOperator,
  input: CreateProviderConfigInput,
): Promise<ProviderConfigView> {
  const id = newId<'AiProviderConfigId'>();
  const dataKey = await keys.generateDataKey({ providerConfigId: id });
  const ciphertext = Buffer.from(encryptString(dataKey.plaintext.key, input.apiKey, apiKeyAad(id)));

  const row = await withPlatformAdminScope(async (tx) => {
    if (input.isDefault) {
      await tx.update(schema.aiProviderConfig).set({ isDefault: false });
    }

    const inserted = await tx
      .insert(schema.aiProviderConfig)
      .values({
        id,
        provider: input.provider,
        model: input.model,
        apiKeyCiphertext: ciphertext,
        dataKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
        dataKeyMasterId: dataKey.wrapped.masterKeyId,
        isDefault: input.isDefault,
        label: input.label,
      })
      .returning();

    return inserted[0];
  });

  if (row === undefined) throw errors.internal(undefined, 'Failed to create AI provider config.');

  await recordOperatorAction(operator.userId, 'ai.providers.create', {
    id,
    provider: input.provider,
    model: input.model,
  });

  /* Global config, `SYSTEM_ORG` envelope — `flags.service.ts`'s identical
     choice for the identical reason: no single org's scope applies. */
  await deps.events.publish([
    createEvent(
      aiProviderConfigCreated,
      { id, provider: input.provider, model: input.model },
      { orgId: SYSTEM_ORG, actorId: operator.userId, requestId: operator.requestId },
    ),
  ]);

  return viewOf(row);
}

/**
 * Re-encrypts a config's API key under a fresh data key. The old wrapped key
 * is simply overwritten — nothing else in this table references the
 * previous ciphertext, unlike a subaccount whose SID other tables key on.
 */
export async function rotateProviderConfigKey(
  deps: AiProviderConfigDeps,
  keys: KeyProvider,
  operator: PlatformOperator,
  id: string,
  apiKey: string,
): Promise<ProviderConfigView> {
  const dataKey = await keys.generateDataKey({ providerConfigId: id });
  const ciphertext = Buffer.from(encryptString(dataKey.plaintext.key, apiKey, apiKeyAad(id)));

  const row = await withPlatformAdminScope(async (tx) => {
    const updated = await tx
      .update(schema.aiProviderConfig)
      .set({
        apiKeyCiphertext: ciphertext,
        dataKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
        dataKeyMasterId: dataKey.wrapped.masterKeyId,
        updatedAt: new Date(),
      })
      .where(eq(schema.aiProviderConfig.id, id))
      .returning();

    return updated[0];
  });

  if (row === undefined) throw errors.notFound('No AI provider config with that id.');

  await recordOperatorAction(operator.userId, 'ai.providers.rotate_key', { id });

  await deps.events.publish([
    createEvent(aiProviderConfigKeyRotated, { id }, {
      orgId: SYSTEM_ORG,
      actorId: operator.userId,
      requestId: operator.requestId,
    }),
  ]);

  return viewOf(row);
}

/**
 * Marks one config the global default — the row an org with no override
 * resolves to. Two statements in one transaction, not one: the partial
 * unique index on `is_default` (migration 0099) allows only one true row at
 * a time, so the old default is cleared BEFORE the new one is set, never the
 * reverse and never in the same statement.
 */
export async function setDefaultProviderConfig(
  deps: AiProviderConfigDeps,
  operator: PlatformOperator,
  id: string,
): Promise<ProviderConfigView> {
  const row = await withPlatformAdminScope(async (tx) => {
    await tx.update(schema.aiProviderConfig).set({ isDefault: false });

    const updated = await tx
      .update(schema.aiProviderConfig)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(schema.aiProviderConfig.id, id))
      .returning();

    return updated[0];
  });

  if (row === undefined) throw errors.notFound('No AI provider config with that id.');

  await recordOperatorAction(operator.userId, 'ai.providers.set_default', { id });

  await deps.events.publish([
    createEvent(aiProviderConfigDefaultChanged, { id }, {
      orgId: SYSTEM_ORG,
      actorId: operator.userId,
      requestId: operator.requestId,
    }),
  ]);

  return viewOf(row);
}

/** Sets, or changes, one org's provider override (§3.3). */
export async function setOrgProviderOverride(
  deps: AiProviderConfigDeps,
  operator: PlatformOperator,
  orgId: OrgId,
  providerConfigId: string,
): Promise<void> {
  await withPlatformAdminScope(async (tx) => {
    await tx
      .insert(schema.aiOrgOverrides)
      .values({ orgId, providerConfigId, setBy: operator.userId })
      .onConflictDoUpdate({
        target: schema.aiOrgOverrides.orgId,
        set: { providerConfigId, setBy: operator.userId, updatedAt: new Date() },
      });
  });

  await recordOperatorAction(operator.userId, 'ai.org_override.set', { orgId, providerConfigId });

  /* THIS org's own envelope, unlike the catalog events above — an override
     names one specific org, so it belongs in that org's own event stream,
     not the platform-global one. */
  await deps.events.publish([
    createEvent(aiOrgOverrideSet, { providerConfigId }, {
      orgId,
      actorId: operator.userId,
      requestId: operator.requestId,
    }),
  ]);
}

/** Clears an org's override — it falls back to the global default. */
export async function clearOrgProviderOverride(
  deps: AiProviderConfigDeps,
  operator: PlatformOperator,
  orgId: OrgId,
): Promise<void> {
  await withPlatformAdminScope(async (tx) => {
    await tx.delete(schema.aiOrgOverrides).where(eq(schema.aiOrgOverrides.orgId, orgId));
  });

  await recordOperatorAction(operator.userId, 'ai.org_override.clear', { orgId });

  await deps.events.publish([
    createEvent(aiOrgOverrideCleared, {}, {
      orgId,
      actorId: operator.userId,
      requestId: operator.requestId,
    }),
  ]);
}

/**
 * An org's own resolved override, for the console's per-org detail view.
 * Reads under the ORG's OWN scope (§2.3's resolver does too) rather than
 * `withPlatformAdminScope` — this is a single, already-known org, not a
 * cross-tenant scan, so the ordinary tenant-isolation policy is the right
 * tool rather than the operator bypass.
 */
export async function getOrgProviderOverride(orgId: OrgId): Promise<string | undefined> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ providerConfigId: schema.aiOrgOverrides.providerConfigId })
      .from(schema.aiOrgOverrides)
      .where(eq(schema.aiOrgOverrides.orgId, orgId))
      .limit(1);
    return rows[0]?.providerConfigId;
  });
}

/* -------------------------------------------------------------------------- *
 * Reporting (§3.3)
 * -------------------------------------------------------------------------- */

export interface AiSpendReportRow {
  readonly orgId: string;
  readonly model: string;
  readonly totalCents: number;
  readonly calls: number;
}

/**
 * Cross-org spend, grouped by org AND model — unlike telephony's own
 * `spendReport` (which is per-org, gated `recording:read`, and runs inside
 * `withOrgScope`), this is genuinely a platform-operator view: §3.3 asks for
 * "per-org spend" across the WHOLE deployment, on the operator tier, the
 * same reasoning `platformAdmin.audit.list` and the org directory already
 * use `withPlatformAdminScope` for.
 */
export async function aiSpendReport(
  operator: PlatformOperator,
  input: { readonly sinceDays: number },
): Promise<readonly AiSpendReportRow[]> {
  const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000);

  const rows = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        orgId: schema.aiUsageLedger.orgId,
        model: schema.aiUsageLedger.model,
        totalCents: sumColumn(schema.aiUsageLedger.costCents),
        calls: countRows(schema.aiUsageLedger.id),
      })
      .from(schema.aiUsageLedger)
      .where(gte(schema.aiUsageLedger.occurredAt, since))
      .groupBy(schema.aiUsageLedger.orgId, schema.aiUsageLedger.model),
  );

  await recordOperatorAction(operator.userId, 'ai.spend_report', { sinceDays: input.sinceDays });

  return rows.map((row) => ({
    orgId: row.orgId,
    model: row.model,
    totalCents: Math.max(0, Number.parseInt(row.totalCents, 10) || 0),
    calls: Math.max(0, Number.parseInt(row.calls, 10) || 0),
  }));
}
