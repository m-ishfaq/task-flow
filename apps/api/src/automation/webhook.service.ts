import { and, asc, desc, eq, gt, or, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { PAGE_DEFAULT, decodeNameKeyCursor, encodeNameKeyCursor } from './pagination.js';
import { errors, type KeyProvider } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { can } from '@taskflow/policy';
import { encryptString, isAllowedUrl, issueToken, newId } from '@taskflow/security';
import type { AutomationActor } from './automation.service.js';
import { translatingConstraints } from '../work/shared.js';
import {
  webhookCreated,
  webhookDeleted,
  webhookDeliveryQueued,
  webhookUpdated,
} from './webhook-events.js';

/**
 * Outbound-webhook registry and enqueue (ai/phase-10-automation.md §5, Wave 2).
 *
 * Two halves, one file:
 *
 *  - the REGISTRY — org-scoped endpoints, floored on `webhook:manage` at the
 *    route. Org furniture with no resource for a tuple to point at, exactly
 *    like automations themselves;
 *  - the ENQUEUE — called by the worker's executor when a rule runs a
 *    `call_webhook` action. It enforces `webhook:manage` ITSELF, because it is
 *    not reached through a route: the §2 rule that every action is authorized
 *    against the rule owner's live permissions has no `route({ permission })`
 *    to do the enforcing, so this function is that check. A member who cannot
 *    manage webhooks cannot write a rule that calls them.
 *
 * ## The signing secret is minted once and never readable again
 *
 * Creation mints a `tf_whs` token, stores it envelope-encrypted under a
 * PER-WEBHOOK data key (the comms.subaccounts recipe — see the migration's
 * header for why the delivery loop needs the plaintext and therefore a hash
 * would not do), and returns the token to the caller exactly once. There is
 * no read-back route and no update that rotates it: the org pastes the secret
 * into its receiver, and a lost secret means recreating the webhook.
 */

export interface WebhookSummary {
  readonly webhookId: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly disabledAt: Date | null;
  readonly failureCount: number;
  readonly createdAt: Date;
}

export interface WebhookDeliverySummary {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly nextAttemptAt: Date;
  readonly createdAt: Date;
}

/** The triggering event, narrowed to what the enqueue needs. */
export interface EnqueueEvent {
  readonly id: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

type WebhookActor = AutomationActor;

const orgOf = (actor: WebhookActor) => actor.subject.orgId;
const userOf = (actor: WebhookActor) => actor.subject.userId;

/** Authenticated context for the events. Same envelope every other service uses. */
const envelopeOf = (actor: WebhookActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

/**
 * The AAD binding a webhook's signing secret to its org and row.
 *
 * The same shape the telephony module uses for its encrypted credentials: a
 * ciphertext stolen out of the database is authenticated to exactly one row,
 * so it cannot be transplanted into another org's webhook — decryption there
 * would fail the AAD check before a single byte of key was used.
 *
 * Exported because the WORKER decrypts with it at delivery time, and one
 * definition in one file is what keeps the two sides from drifting — a
 * mismatch fails LOUD (the decrypt throws), but only after an incident call
 * has already gone out pointing at the wrong row.
 */
export function signingAad(orgId: string, webhookId: string): string {
  return `webhook-signing:${orgId}:${webhookId}`;
}

export async function listWebhooks(
  actor: WebhookActor,
  cursor: string | null = null,
  limit: number = PAGE_DEFAULT,
): Promise<{ readonly webhooks: readonly WebhookSummary[]; readonly nextCursor: string | null }> {
  const decoded = cursor === null ? null : decodeNameKeyCursor(cursor);

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        webhookId: schema.webhooks.id,
        name: schema.webhooks.name,
        url: schema.webhooks.url,
        enabled: schema.webhooks.enabled,
        disabledAt: schema.webhooks.disabledAt,
        failureCount: schema.webhooks.failureCount,
        createdAt: schema.webhooks.createdAt,
      })
      .from(schema.webhooks)
      .where(
        and(
          eq(schema.webhooks.orgId, orgOf(actor)),
          /* Resume after the cursor: `(name, id) > (cursor.name, cursor.id)`,
             written as plain operators because raw `sql` is banned here. */
          ...(decoded === null
            ? []
            : [
                or(
                  gt(schema.webhooks.name, decoded.name),
                  and(eq(schema.webhooks.name, decoded.name), gt(schema.webhooks.id, decoded.id)),
                ),
              ]),
        ),
      )
      .orderBy(asc(schema.webhooks.name), asc(schema.webhooks.id))
      // One extra row answers "is there a next page" without a COUNT.
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      webhooks: page.map((row) => ({ ...row })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeNameKeyCursor({ name: last.name, id: last.webhookId })
          : null,
    };
  });
}

export async function createWebhook(
  actor: WebhookActor,
  input: { readonly name: string; readonly url: string },
  keys: KeyProvider,
): Promise<{ readonly webhookId: string; readonly signingSecret: string }> {
  /* The SHAPE check at create time is a usability service: it catches a
     typo (a `file:` URL, a port nobody can reach) while the author is still
     looking at the form. It is deliberately NOT the control — DNS can change
     between now and delivery, so the per-hop resolution check in the worker
     is what actually refuses a private endpoint. `outbound-url.ts`'s own
     header says the caller must do both halves; this function does the cheap
     half, the delivery loop does the expensive one. */
  const verdict = isAllowedUrl(input.url);
  if (!verdict.allowed) {
    throw errors.validation(
      { url: [verdict.reason ?? 'That URL cannot be reached.'] },
      'That URL cannot be reached.',
    );
  }

  const webhookId = newId<'WebhookId'>();
  const orgId = orgOf(actor);
  const issued = issueToken('webhookSigning');
  const dataKey = await keys.generateDataKey({ orgId });

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await tx.insert(schema.webhooks).values({
          id: webhookId,
          orgId,
          name: input.name,
          url: input.url,
          createdBy: userOf(actor),
          signingKeyCiphertext: Buffer.from(
            encryptString(dataKey.plaintext.key, issued.token, signingAad(orgId, webhookId)),
          ),
          signingKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
          signingKeyMasterId: dataKey.wrapped.masterKeyId,
        });

        await outboxWriter.append(tx, [
          createEvent(
            webhookCreated,
            { webhookId, name: input.name, enabled: true },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('A webhook with that name already exists.'),
  );

  return { webhookId, signingSecret: issued.token };
}

export async function updateWebhook(
  actor: WebhookActor,
  input: { readonly webhookId: string; readonly name: string; readonly url: string },
): Promise<{ readonly name: string }> {
  const verdict = isAllowedUrl(input.url);
  if (!verdict.allowed) {
    throw errors.validation(
      { url: [verdict.reason ?? 'That URL cannot be reached.'] },
      'That URL cannot be reached.',
    );
  }

  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadWebhook(tx, input.webhookId);

    await tx
      .update(schema.webhooks)
      .set({ name: input.name, url: input.url, updatedAt: new Date() })
      .where(eq(schema.webhooks.id, input.webhookId));

    await outboxWriter.append(tx, [
      createEvent(
        webhookUpdated,
        {
          webhookId: input.webhookId,
          name: input.name,
          wasEnabled: existing.enabled,
          enabled: existing.enabled,
        },
        envelopeOf(actor),
      ),
    ]);

    return { name: input.name };
  });
}

/**
 * The endpoint kill switch, with the same reasoning as the rule kill switch:
 * its own route so stopping a misbehaving endpoint never requires sending a
 * complete, valid body through the same validation.
 *
 * Re-enabling clears the AUTO-disable markers (`disabledAt`, `failureCount`)
 * — a person deciding an endpoint is fixed is a fresh start, and the health
 * read must not keep showing a wound that healed.
 */
export async function setWebhookEnabled(
  actor: WebhookActor,
  input: { readonly webhookId: string; readonly enabled: boolean },
): Promise<{ readonly enabled: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadWebhook(tx, input.webhookId);

    await tx
      .update(schema.webhooks)
      .set({
        enabled: input.enabled,
        ...(input.enabled
          ? { disabledAt: null, failureCount: 0, updatedAt: new Date() }
          : { updatedAt: new Date() }),
      })
      .where(eq(schema.webhooks.id, input.webhookId));

    await outboxWriter.append(tx, [
      createEvent(
        webhookUpdated,
        {
          webhookId: input.webhookId,
          name: existing.name,
          wasEnabled: existing.enabled,
          enabled: input.enabled,
        },
        envelopeOf(actor),
      ),
    ]);

    return { enabled: input.enabled };
  });
}

export async function deleteWebhook(
  actor: WebhookActor,
  input: { readonly webhookId: string },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadWebhook(tx, input.webhookId);

    /* A real delete. The delivery queue goes with it by the composite FK's
       cascade — a delivery for an endpoint that no longer exists is history
       about a thing that is gone, and the ACTIONS those deliveries described
       are already in the audit log. */
    await tx.delete(schema.webhooks).where(eq(schema.webhooks.id, input.webhookId));

    await outboxWriter.append(tx, [
      createEvent(
        webhookDeleted,
        { webhookId: input.webhookId, name: existing.name },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

/** The recent delivery history for one endpoint — the "did it go out" question. */
export async function listWebhookDeliveries(
  actor: WebhookActor,
  input: { readonly webhookId: string; readonly limit: number },
): Promise<readonly WebhookDeliverySummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        deliveryId: schema.webhookDeliveries.id,
        webhookId: schema.webhookDeliveries.webhookId,
        eventId: schema.webhookDeliveries.eventId,
        eventName: schema.webhookDeliveries.eventName,
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        lastStatusCode: schema.webhookDeliveries.lastStatusCode,
        lastError: schema.webhookDeliveries.lastError,
        nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
        createdAt: schema.webhookDeliveries.createdAt,
      })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.orgId, orgOf(actor)),
          eq(schema.webhookDeliveries.webhookId, input.webhookId),
        ),
      )
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(input.limit);

    return rows.map((row) => ({ ...row }));
  });
}

/**
 * The `call_webhook` action's service-layer entry point — called by the
 * worker's executor, exactly as every other action calls its service.
 *
 * This is where the §2 authorization happens: `webhook:manage` is org-level,
 * so the check is a single `can()` with no target — the same shape the route
 * floor uses, and deliberately the same one, so "may this rule call webhooks"
 * and "may this person manage webhooks" can never diverge.
 *
 * ## Dedupe
 *
 * The engine is at-least-once, so a redelivered triggering event would run
 * this twice. The unique `(org_id, webhook_id, event_id)` key makes the second
 * insert a no-op: the receiver is told to deduplicate on the event id, and the
 * database enforces the same promise on the queue side.
 */
export async function enqueueWebhookDelivery(
  actor: WebhookActor,
  input: { readonly webhookId: string; readonly event: EnqueueEvent },
): Promise<{ readonly deliveryId: string | null }> {
  const orgId = orgOf(actor);

  if (!can(actor.subject, 'webhook:manage').allowed) {
    throw errors.forbidden('Only members who can manage webhooks may make a rule call them.');
  }

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ enabled: schema.webhooks.enabled })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, input.webhookId))
      .limit(1);

    const webhook = rows[0];
    if (webhook === undefined) throw errors.notFound();

    /* A disabled endpoint refuses the enqueue. The rule's run records a failed
       action with this message — visible, rather than a queued delivery that
       the loop then silently cannot send. */
    if (!webhook.enabled) throw errors.conflict('That webhook is disabled.');

    const deliveryId = newId<'WebhookDeliveryId'>();

    /* The canonical body. Stored once and sent byte-identical on every retry,
       which is what makes the receiver's event-id dedupe meaningful — a retry
       that re-serialized the payload would be a new body to a receiver that
       compares the two. The triggering payload rides along; it is the same
       data the event registry already holds. */
    const payload = {
      eventId: input.event.id,
      eventName: input.event.name,
      orgId,
      occurredAt: new Date().toISOString(),
      payload: input.event.payload,
    };

    const inserted = await tx
      .insert(schema.webhookDeliveries)
      .values({
        id: deliveryId,
        orgId,
        webhookId: input.webhookId,
        eventId: input.event.id,
        eventName: input.event.name,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: schema.webhookDeliveries.id });

    const won = inserted[0];
    if (won !== undefined) {
      await outboxWriter.append(tx, [
        createEvent(
          webhookDeliveryQueued,
          {
            webhookId: input.webhookId,
            deliveryId,
            eventId: input.event.id,
            eventName: input.event.name,
          },
          envelopeOf(actor),
        ),
      ]);
    }

    return { deliveryId: won?.id ?? null };
  });
}

/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

interface WebhookRow {
  readonly name: string;
  readonly enabled: boolean;
}

async function loadWebhook(tx: Tx, webhookId: string): Promise<WebhookRow> {
  const rows = await tx
    .select({ name: schema.webhooks.name, enabled: schema.webhooks.enabled })
    .from(schema.webhooks)
    .where(eq(schema.webhooks.id, webhookId))
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound();

  return { name: row.name, enabled: row.enabled };
}
