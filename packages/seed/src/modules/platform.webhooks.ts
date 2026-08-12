import { createEvent } from '@taskflow/events';
import { webhookCreated } from '@taskflow/api/events/automation-webhooks';
import { encryptString, issueToken } from '@taskflow/security';
import { defineSeedModule } from '../registry.js';
import { envelopeFor } from '../support.js';
import { orgsModule, type SeededOrg } from './tenancy.orgs.js';

/**
 * Outbound webhooks (Phase 10 Wave 2) — one per org, with a REAL secret.
 *
 * ## Why the signing secret is real, and why this module can skip itself
 *
 * A webhook row is `signing_key_ciphertext` envelope-encrypted under a
 * per-webhook data key, exactly like `comms.subaccounts`' auth token — and the
 * delivery loop unwraps it with the application's own master key the first
 * time it signs a delivery. A seeded ciphertext that was invented, or wrapped
 * under a key the running app does not hold, would fail that first unwrap in
 * a way that reads like a bug in the delivery loop. So this module generates
 * the secret through the REAL path — `issueToken('webhookSigning')`, a data
 * key from `ctx.keys`, `encryptString` — and it SKIPS itself entirely when
 * `ctx.keys` is null, which is the same null-is-\"skip\" rule `storage` and
 * `telephony` follow (context.ts). The CLI warns when it happens, so a demo
 * run without `MASTER_KEY_*` set is told what is missing rather than being
 * silently short a feature.
 *
 * The plaintext secret is printed once, exactly like the API service does at
 * creation — a demo developer pastes it into their test receiver (or just
 * reads it) and throws it away; there is no read-back route.
 */

export interface WebhooksOutput {
  readonly webhookCount: number;
  readonly signingSecret: string | null;
}

export const webhooksModule = defineSeedModule({
  name: 'platform.webhooks',
  requires: [orgsModule],
  tables: ['platform.webhooks'],

  async seed(ctx): Promise<WebhooksOutput> {
    const keys = ctx.keys;
    if (keys === null) {
      ctx.log('platform.webhooks: no key provider — skipped.');
      return { webhookCount: 0, signingSecret: null };
    }

    const { orgs } = ctx.use(orgsModule);
    let webhookCount = 0;
    let signingSecret: string | null = null;

    for (const org of orgs) {
      const webhookId = ctx.rng.uuid(ctx.now);
      const issued = issueToken('webhookSigning');
      // The data key is generated with the same context the real service uses
      // (`{ orgId }` — comms.telephony's header documents why a placeholder
      // here fails the first time real code reads the row).
      const dataKey = await keys.generateDataKey({ orgId: org.id });
      const aad = `webhook-signing:${org.id}:${webhookId}`;
      const createdBy = ownerOf(org);

      await ctx.orgScope(org.id, () =>
        ctx.db.insert(
          'platform.webhooks',
          [
            'id',
            'org_id',
            'name',
            'url',
            'enabled',
            'failure_count',
            'created_by',
            'signing_key_ciphertext',
            'signing_key_wrapped',
            'signing_key_master_id',
            'created_at',
            'updated_at',
          ],
          [
            [
              webhookId,
              org.id,
              `${org.name} relay`,
              'https://webhook.site/taskflow-seed-demo',
              true,
              0,
              createdBy,
              Buffer.from(encryptString(dataKey.plaintext.key, issued.token, aad)),
              Buffer.from(dataKey.wrapped.wrapped),
              dataKey.wrapped.masterKeyId,
              org.createdAt.toISOString(),
              org.createdAt.toISOString(),
            ],
          ],
        ),
      );

      ctx.emit(
        createEvent(
          webhookCreated,
          { webhookId, name: `${org.name} relay`, enabled: true },
          envelopeFor(org.id, createdBy, org.createdAt),
        ),
      );

      // The one time the secret exists in plaintext. Keep the LAST org's —
      // it is a demo credential for a webhook.site-style receiver, and
      // exposing every org's secret in the run log is louder than useful.
      signingSecret = issued.token;
      webhookCount += 1;
    }

    ctx.log(`platform.webhooks: ${String(webhookCount)} webhook(s)`);
    return { webhookCount, signingSecret };
  },
});

function ownerOf(org: SeededOrg): string {
  return org.owner.id;
}
