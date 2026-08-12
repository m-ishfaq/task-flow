import type { FastifyInstance } from 'fastify';
import { withOrgScope } from '@taskflow/db';
import { applyBillingWebhookEvent } from './webhook-apply.service.js';
import { commitWebhookEvent, verifyInboundBillingWebhook } from './webhook.js';
import type { BillingDeps } from './deps.js';

/**
 * The inbound Stripe webhook route (Phase 12 Wave 3 §3.5).
 *
 * ⚠ Human-review surface — see `webhook.ts`'s own header.
 *
 * A plain Fastify route, not a tRPC procedure, for the identical reason
 * `registerTelephonyWebhooks` is: an unauthenticated third-party POST has no
 * principal to force into `route({ permission })`'s shape.
 *
 * Registered unconditionally (unlike telephony's carrier-gated
 * registration) — `billingDeps` always exists (§3.3's own "never returns
 * undefined" contract), so this route always exists too. Against a `fake`
 * `PaymentProvider`, every real Stripe signature fails to parse and every
 * request is refused — which is the correct, safe behavior for an instance
 * nobody configured a live processor for, not a special case to code around.
 */
export interface BillingWebhookRouteDeps {
  readonly billing: BillingDeps;
}

export function registerBillingWebhooks(app: FastifyInstance, deps: BillingWebhookRouteDeps): void {
  const { billing } = deps;

  /* Registered in its OWN encapsulated scope — unlike telephony's form-
     encoded parser (which has no Fastify built-in to collide with), Fastify
     DOES ship a default 'application/json' parser at the root, and calling
     `addContentTypeParser('application/json', ...)` a second time at the SAME
     scope throws `FST_ERR_CTP_ALREADY_PRESENT` at boot — confirmed against a
     real Fastify instance, not assumed. A child scope's override is a
     redefinition for THAT scope's own routes only, leaving the root's default
     parser (and the tRPC plugin's own scoped override under `/trpc`) both
     untouched — the same encapsulation the tRPC plugin itself relies on. */
  void app.register((scoped, _opts, done) => {
    /* Stripe's signature covers the EXACT raw bytes it sent — this route
       needs its own raw-string capture, or the default JSON parser would
       hand this handler an object that can never byte-match what was
       signed. */
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scoped.post('/webhooks/billing/stripe', async (request, reply) => {
      if (billing.webhookSecret === undefined) {
        /* PAYMENTS_PROVIDER=fake (or a stripe deployment with no secret
           configured, which deps.ts already refuses at boot for — this branch
           is reachable only in the fake case). Answering 404 rather than 200
           or 500: there is genuinely no webhook endpoint here to a caller who
           is not Stripe, and a 200 would tell a prober this path exists. */
        return reply.status(404).send();
      }

      const verdict = await verifyInboundBillingWebhook(
        {
          payload: request.body as string,
          signature: request.headers['stripe-signature'] as string | undefined,
        },
        billing.payments,
        billing.webhookSecret,
      );

      /* Every rejection answers the same way, with no detail distinguishing
         them — the identical reasoning telephony's webhook route gives: which
         check failed is a map of the verification logic to hand an attacker. */
      if (!verdict.ok) {
        return reply.status(400).send();
      }

      /* commit + apply in ONE transaction — see webhook-apply.service.ts's
         own header for why splitting these across two would reintroduce the
         exact "retry silently lost" failure the nonce discipline exists to
         prevent. */
      await withOrgScope(verdict.orgId, async (tx) => {
        await commitWebhookEvent(tx, verdict.orgId, verdict.event.providerEventId);
        await applyBillingWebhookEvent(tx, billing, verdict.orgId, verdict.event, request.id);
      });

      return reply.status(200).send();
    });

    done();
  });
}
