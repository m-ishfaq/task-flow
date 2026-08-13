import { z } from 'zod';
import { publicRoute, route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import * as integrations from './integration.service.js';
import type { IntegrationDeps } from './integration.service.js';
import type { AutomationActor } from './automation.service.js';

/**
 * Connector routes (ai/phase-10-automation.md §7, Wave 4 slice 2).
 *
 * Every route floors on `integration:manage` — owner/admin, org-level, already
 * in the matrix — except `complete`, which is a `publicRoute` on purpose: the
 * browser round trip to Slack/GitHub loses the session, and the org the row is
 * written under comes from the SIGNED STATE token minted by `begin`, never from
 * the request. See `integration.service.ts`'s header for the trust model.
 *
 * ## Which routes are stepUp, and why
 *
 * §7.8: "Connect is stepUp: true, the `phoneNumber:purchase` bar — wiring the
 * org's outbound identity is a standing-capability decision, not a
 * refresh-click." Connect here is `begin` AND `selectRepo` — the GitHub
 * connect completes at the repo choice, so choosing WHICH repository the org's
 * outbound token and verify secret attach to is the standing-capability act.
 * That remains practical after the OAuth round trip because a refresh never
 * advances `authenticatedAt` (identity.service.ts's comment on the subject),
 * so the refreshed token still carries the credential proof from moments
 * before `begin`.
 *
 * `disconnect` is stepUp for the same reason in reverse: removing the org's
 * outbound identity is as deliberate a change to its standing capabilities as
 * adding one. A hijacked session that cannot re-prove a credential can turn
 * the connector off but not point it somewhere else.
 */
const ConnectorProviderSchema = z.enum(['slack', 'github']);

const IntegrationSummaryOutput = z.object({
  integrationId: z.string(),
  provider: ConnectorProviderSchema,
  name: z.string(),
  providerScope: z.string(),
  status: z.enum(['connected', 'disconnected']),
  createdAt: z.date(),
});

const RepoOutput = z.object({ name: z.string(), fullName: z.string() });

const CompleteOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('connected'),
    provider: z.literal('slack'),
    integrationId: z.string(),
    name: z.string(),
    providerScope: z.string(),
    webhookUrl: z.string().nullable(),
  }),
  z.object({
    status: z.literal('pending_repo'),
    provider: z.literal('github'),
    integrationId: z.string(),
    login: z.string(),
    repos: z.array(RepoOutput).readonly(),
    webhookUrl: z.string().nullable(),
    /* The per-org verify secret, shown EXACTLY once — the output schema is
       the contract, the same way the webhook create route's output schema is. */
    verifySecret: z.string(),
  }),
]);

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: AutomationActor['requestId'];
}): AutomationActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createIntegrationRouter(deps: IntegrationDeps) {
  return router({
    /**
     * Which providers this server has credentials for, plus the webhook
     * origin — read by the Integrations tab so an unconfigured provider's
     * connect button does not render, the `oauth.providers` precedent. A
     * provider missing either half of its client id/secret is absent here.
     */
    capabilities: route({ permission: 'integration:manage' })
      .input(z.object({}).strict())
      .output(
        z
          .object({
            slack: z.boolean(),
            github: z.boolean(),
            webhookOrigin: z.string().nullable(),
          })
          .strict(),
      )
      .query(() => integrations.integrationCapabilities(deps)),

    list: route({ permission: 'integration:manage' })
      .input(z.object({}).strict())
      .output(z.array(IntegrationSummaryOutput).readonly())
      .query(({ ctx }) => integrations.listIntegrations(actorOf(ctx))),

    /**
     * Starts a connect: mints the signed state token and returns the
     * provider's authorization URL. The caller navigates away for the
     * provider's consent screen; `complete` is where the flow resumes.
     *
     * stepUp — see the file header.
     */
    begin: route({ permission: 'integration:manage', stepUp: true })
      .input(z.object({ provider: ConnectorProviderSchema }).strict())
      .output(z.object({ authorizationUrl: z.string() }).strict())
      .mutation(({ input, ctx }) => integrations.beginIntegration(actorOf(ctx), deps, input)),

    /**
     * The browser is back from the provider. PUBLIC — the round trip lost the
     * session — and that is safe because the state token it verifies was
     * minted by `begin` for exactly this org and user. The provider param is
     * cross-checked against the state's own claim, so a state minted for
     * Slack cannot complete a GitHub callback.
     */
    complete: publicRoute({
      publicReason:
        'The browser round trip to Slack/GitHub loses the session; the signed state token carries the org and user the connect is for.',
    })
      .input(
        z
          .object({
            provider: ConnectorProviderSchema,
            code: z.string().min(1),
            state: z.string().min(1),
          })
          .strict(),
      )
      .output(CompleteOutput)
      .mutation(({ input, ctx }) => integrations.completeIntegration(deps, input, ctx.requestId)),

    /**
     * The repos a pending GitHub connect's stored token can reach — the
     * picker's options. Exists so the callback page can rebuild the picker
     * after a refresh, when the one-time authorization code is already
     * burned and `complete` cannot run again.
     */
    repos: route({ permission: 'integration:manage' })
      .input(z.object({ integrationId: z.string().uuid() }).strict())
      .output(z.array(RepoOutput).readonly())
      .query(({ input, ctx }) => integrations.listReposForIntegration(actorOf(ctx), deps, input)),

    /**
     * Completes the GitHub connect. stepUp — the repo choice is where the
     * org's outbound identity actually lands (§7.8). Validates the chosen
     * repository against what the stored token can genuinely reach, re-keys
     * the row on the full_name, and emits the connected event `complete`
     * deliberately withheld.
     */
    selectRepo: route({ permission: 'integration:manage', stepUp: true })
      .input(
        z
          .object({ integrationId: z.string().uuid(), fullName: z.string().min(1).max(512) })
          .strict(),
      )
      .output(IntegrationSummaryOutput)
      .mutation(({ input, ctx }) => integrations.selectRepo(actorOf(ctx), deps, input)),

    /**
     * Flips a connector to 'disconnected' — never deletes. stepUp, see the
     * file header. The row survives as the org's audit trail of having
     * authorized this scope.
     */
    disconnect: route({ permission: 'integration:manage', stepUp: true })
      .input(z.object({ integrationId: z.string().uuid() }).strict())
      .output(z.object({ disconnected: z.literal(true) }).strict())
      .mutation(({ input, ctx }) => integrations.disconnectIntegration(actorOf(ctx), input)),
  });
}
