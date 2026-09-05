import { eq, schema, withOrgScope } from '@taskflow/db';
import { errors, type AiProvider, type KeyProvider, type OrgId } from '@taskflow/contracts';
import { decryptString, identityFieldAad } from '@taskflow/security';
import { AnthropicProvider } from '@taskflow/ai';

/**
 * Resolves the `AiProvider` one org should use (§2.3): the org's own
 * override if one is set, otherwise whichever catalog row is marked
 * default.
 *
 * Both reads happen inside ONE ORDINARY `withOrgScope` transaction, not
 * `withGlobalScope`. `platform.ai_org_overrides` is RLS-scoped to this org
 * (this module reads only its own row); `platform.ai_provider_config` has
 * no RLS at all — a genuinely global catalog, like `platform.flag_overrides`
 * — so an ordinary query against it inside any scope sees every row
 * regardless of `app.org_id`. Neither read needs the pre-tenant connection
 * `withGlobalScope` exists for, which is exactly as well since
 * `apps/api/src/ai` is not on that helper's exempt-module list
 * (`packages/config/eslint/security.js`).
 */

export interface ResolvedAiProvider {
  readonly provider: AiProvider;
  readonly providerName: string;
  readonly model: string;
}

/**
 * AAD binding the ciphertext to the row it belongs in — `identityFieldAad`'s
 * shape (table + column + row, no org) is exactly what a genuinely global
 * row needs, the same reason `apps/api/src/identity/totp.service.ts` reuses
 * it rather than `fieldAad` for a row with no `org_id` at all. Reused here,
 * not duplicated: the string it builds carries no identity-specific
 * semantics, only "this table, this column, this row".
 */
function apiKeyAad(providerConfigId: string): string {
  return identityFieldAad({
    table: 'platform.ai_provider_config',
    column: 'api_key_ciphertext',
    rowId: providerConfigId,
  });
}

function providerFor(provider: string, apiKey: string): AiProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey });
    default:
      /* Unreachable through the write path — `ai_provider_config_provider_valid`
         (migration 0099) is a closed CHECK constraint — so a row landing
         here means the constraint and this switch have drifted, not that a
         caller sent bad input. */
      throw new Error(`No AiProvider implementation registered for provider "${provider}".`);
  }
}

export async function resolveAiProvider(
  orgId: OrgId,
  keys: KeyProvider,
): Promise<ResolvedAiProvider> {
  const row = await withOrgScope(orgId, async (tx) => {
    const overrideRows = await tx
      .select({ providerConfigId: schema.aiOrgOverrides.providerConfigId })
      .from(schema.aiOrgOverrides)
      .where(eq(schema.aiOrgOverrides.orgId, orgId))
      .limit(1);

    const overrideConfigId = overrideRows[0]?.providerConfigId;

    const configRows = await tx
      .select()
      .from(schema.aiProviderConfig)
      .where(
        overrideConfigId === undefined
          ? eq(schema.aiProviderConfig.isDefault, true)
          : eq(schema.aiProviderConfig.id, overrideConfigId),
      )
      .limit(1);

    return configRows[0];
  });

  if (row === undefined) {
    throw errors.notFound('No AI provider is configured for this organization.');
  }

  const dataKey = await keys.unwrapDataKey({
    wrapped: new Uint8Array(row.dataKeyWrapped),
    masterKeyId: row.dataKeyMasterId,
    encryptionContext: { providerConfigId: row.id },
  });

  const apiKey = decryptString(
    dataKey.key,
    new Uint8Array(row.apiKeyCiphertext),
    apiKeyAad(row.id),
  );

  return {
    provider: providerFor(row.provider, apiKey),
    providerName: row.provider,
    model: row.model,
  };
}
