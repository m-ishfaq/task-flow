import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Outbound-webhook events (ai/phase-10-automation.md Wave 2).
 *
 * Governance facts about the webhooks themselves — who registered one, when it
 * was turned off, whether a delivery entered the queue. They deliberately do
 * NOT carry the endpoint URL: the audit log is far more widely readable than
 * the webhook row, and the URL tells an incident review nothing the name does
 * not while giving a broad reader a map of the org's external callbacks. The
 * SIGNING secret never appears in any event, for the obvious reason.
 *
 * `webhook.delivery_queued` is what a `call_webhook` automation action emits
 * (through the service layer, like every other action) — and its existence is
 * why the worker's loop-protection table lists `call_webhook` as emitting it,
 * so a rule whose own trigger is `webhook.delivery_queued` is refused at save.
 */

export const webhookCreated = defineEvent(
  'webhook.created',
  z.object({ webhookId: z.string(), name: z.string(), enabled: z.boolean() }).strict(),
);

export const webhookUpdated = defineEvent(
  'webhook.updated',
  z
    .object({
      webhookId: z.string(),
      name: z.string(),
      /* The BEFORE value, per this codebase's standing rule: an event saying
         only what `enabled` became cannot answer whether it changed, and
         "somebody disabled this endpoint" is exactly the transition worth
         finding. */
      wasEnabled: z.boolean(),
      enabled: z.boolean(),
    })
    .strict(),
);

export const webhookDeleted = defineEvent(
  'webhook.deleted',
  z.object({ webhookId: z.string(), name: z.string() }).strict(),
);

/**
 * A `call_webhook` action enqueued a delivery.
 *
 * `deliveryId` lets an incident review join the governance record to the
 * delivery queue row. `eventId` is the triggering event — the receiver
 * dedupes on it.
 */
export const webhookDeliveryQueued = defineEvent(
  'webhook.delivery_queued',
  z
    .object({
      webhookId: z.string(),
      deliveryId: z.string(),
      eventId: z.string(),
      eventName: z.string(),
    })
    .strict(),
);

/**
 * The delivery loop auto-disabled an endpoint after its dead-letter threshold.
 *
 * Emitted by the worker, not by any API service — which is fine, guardrail 11
 * is scoped to service files, and a background actor writing its own outcome
 * to the outbox is the same shape the notification sweeps already use. The
 * org is notified separately, through a notifications row; this event is the
 * audit-log fact.
 */
export const webhookAutoDisabled = defineEvent(
  'webhook.auto_disabled',
  z.object({ webhookId: z.string(), name: z.string(), failedDeliveries: z.number().int() }).strict(),
);
