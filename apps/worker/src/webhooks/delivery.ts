import { lookup as dnsLookup } from 'node:dns/promises';
import {
  and,
  asc,
  eq,
  hasWebhookDatabase,
  lt,
  outboxWriter,
  schema,
  withOrgScope,
  withWebhookScope,
} from '@taskflow/db';
import { unsafeAsId, type KeyProvider } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import type { Logger } from '@taskflow/observability';
import { DEFAULT_PRODUCT_NAME } from '@taskflow/api/platform-admin/branding-cache';
import {
  buildWebhookSignature,
  decryptString,
  isAllowedUrl,
  isBlockedAddress,
  isIpAddress,
  newId,
} from '@taskflow/security';
import { signingAad } from '@taskflow/api/automation/webhooks';
import { webhookAutoDisabled } from '@taskflow/api/events/automation-webhooks';

/**
 * Outbound webhook delivery (ai/phase-10-automation.md §5, Wave 2).
 *
 * ⚠ The outbound request path. The DECISION about which addresses may be
 * reached lives in `packages/security/outbound-url.ts`; this file is the I/O
 * around it, and the reasoning in `apps/api/src/chat/unfurl.ts`'s header
 * applies verbatim — with one deliberate difference: unfurl REFUSES redirects
 * outright, and this loop re-checks each hop instead. §5 is explicit that the
 * SSRF gate applies PER REDIRECT HOP, because a webhook is a standing
 * instruction rather than a one-shot preview, and a 302 is as cheap for the
 * org as the attacker. A webhook client that followed redirects with the check
 * applied only to the first URL would be a fully working SSRF with a passing
 * test suite.
 *
 * ## The residual every hostname gate shares, stated rather than hidden
 *
 * The gate resolves the hostname, and the connection that follows re-resolves
 * it independently — the addresses verified are the ones at time T, and the
 * connect happens at T+ε. A DNS server that answers the two lookups
 * differently defeats the resolution half of the gate (the same residual
 * `fetchUnfurl` carries, and the reason both files state it). What the gate
 * still refuses outright is any URL whose LITERAL address is private: a direct
 * `http://10.x` or `http://169.254.169.254` never survives either check.
 *
 * ## The claim-only split, and why the loop is shaped like this
 *
 * Migration 0049's `taskflow_webhook` role can CLAIM due deliveries and record
 * their outcomes — and nothing else: it has no grant on `platform.webhooks`,
 * and its SELECT on `webhook_deliveries` is column-level and excludes
 * `payload`. So the loop is three passes:
 *
 *   1. CLAIM, cross-tenant, as `taskflow_webhook` — a conditional UPDATE on
 *      `attempts`, the recording-ingest pattern. `attempts` is both the retry
 *      budget and the optimistic-concurrency token;
 *   2. WORK, per row, under `withOrgScope` as `taskflow_app` — load the
 *      webhook's URL, its signing secret (decrypted with the master key this
 *      process holds) and the payload, then make the request;
 *   3. MARK, again as `taskflow_webhook` — success, retry-with-backoff, or
 *      dead; and only when a delivery dies of FAILURE (not of a disable), a
 *      fourth pass as `taskflow_app` to bump the endpoint's failure counter
 *      and disable it past the threshold, notifying the person who created it.
 *
 * ## At-least-once, and what the receiver is told
 *
 * A worker that dies mid-attempt leaves the row `pending` with an incremented
 * `attempts`, so the next tick retries. The receiver dedupes on the event id
 * in the body; the body itself is stored once and byte-identical across
 * retries, so the dedupe key is stable. Exactly-once delivery to a third
 * party is not achievable, and a retry policy that pretends otherwise drops
 * events.
 */

/** Rows per tick. Bounded so one slow receiver cannot stall the loop forever. */
const BATCH = 10;

/** Retries per delivery. With the backoff below: 30s, 1m, 2m, 4m, 8m — the
    sixth attempt is the last, and its failure dead-letters instead of
    backoff-ing. */
const MAX_ATTEMPTS = 6;

/** The first retry waits 30s; every retry doubles, up to 30 minutes. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Consecutive dead deliveries after which the endpoint is auto-disabled.
 *
 * A webhook that has failed its full retry budget five times in a row is a
 * queue that costs money and delivers nothing — the §5 sentence verbatim. The
 * person who created the endpoint is notified and the endpoint is disabled;
 * re-enabling it (the kill-switch route) is a deliberate human act that
 * resets the counter.
 */
const DISABLE_AFTER_FAILURES = 5;

/** Redirect hops before a delivery is refused outright. */
const MAX_REDIRECT_HOPS = 5;

/** The whole request (headers included) may take this long, no more. */
const TIMEOUT_MS = 15_000;

/** `last_error` is a column a support view renders — keep it small and plain. */
const MAX_ERROR_LENGTH = 500;

export interface DeliveryDeps {
  readonly keys: KeyProvider;
  /** Injected so the suite can answer without a network — never to bypass the gate. */
  readonly fetchImpl: typeof fetch;
  /** Injected so the suite can serve an endpoint from a loopback address. See `defaultLookup`. */
  readonly lookup: (hostname: string) => Promise<readonly string[]>;
}

export interface WebhookDrainResult {
  readonly processed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly disabled: number;
}

type DeliveryOutcome =
  | { readonly kind: 'succeeded'; readonly statusCode: number }
  | { readonly kind: 'failed'; readonly statusCode: number | null; readonly error: string }
  /** The endpoint was disabled between enqueue and delivery. Not a failure. */
  | { readonly kind: 'endpoint_disabled' };

interface ClaimedRow {
  readonly id: string;
  readonly orgId: string;
  readonly webhookId: string;
  /** The attempt number of THIS attempt — the claim already incremented it. */
  readonly attempts: number;
}

/** One claim-and-deliver pass. Exported for the suite. */
export async function drainWebhookDeliveries(
  deps: DeliveryDeps,
  limit = BATCH,
): Promise<WebhookDrainResult> {
  const claimed = await claimDue(limit);
  if (claimed.length === 0) return { processed: 0, delivered: 0, failed: 0, disabled: 0 };

  let delivered = 0;
  let failed = 0;
  let disabled = 0;

  for (const row of claimed) {
    /* A throw here — a decrypt failure, a malformed stored key — must fail
       ONLY this row and follow the same budget path, or one poison delivery
       would abort the batch behind it and, after burning its attempts, sit as
       `pending` forever: dead-letter and disable only ever run inside
       `markOutcome`/`registerFailure`, which a throw skips. */
    let outcome: DeliveryOutcome;
    try {
      outcome = await deliverOne(deps, row);
    } catch (error) {
      outcome = {
        kind: 'failed',
        statusCode: null,
        error: error instanceof Error ? error.message : 'the delivery failed unexpectedly',
      };
    }

    if (outcome.kind === 'succeeded') delivered += 1;
    if (outcome.kind === 'failed') failed += 1;

    await markOutcome(row.id, outcome, row.attempts);

    /* A delivery that dies of FAILURE (not of a disable) is the endpoint's
       wound, and only the last attempt carries it — an endpoint with a
       transient blip must not accumulate permanent damage. */
    if (outcome.kind === 'failed' && row.attempts >= MAX_ATTEMPTS) {
      const result = await registerFailureAndMaybeDisable(row);
      if (result.disabled) disabled += 1;
    }
  }

  return { processed: claimed.length, delivered, failed, disabled };
}

/**
 * Claims up to `limit` due rows by incrementing `attempts`.
 *
 * The conditional UPDATE is the claim, exactly as `recording-ingest.ts`'s
 * claim is: `attempts` is the optimistic-concurrency token, so a row returned
 * here has already been marked attempted and a second loop reading the same
 * row a moment later sees the incremented value. There is deliberately no
 * `FOR UPDATE ... SKIP LOCKED` — the claim role's column-level grants cannot
 * take a row lock (the backlinks lesson), and the conditional UPDATE needs no
 * lock at all.
 *
 * `next_attempt_at` is the backoff, so a dead endpoint stops costing a claim
 * per tick long before it is dead-lettered.
 */
async function claimDue(limit: number): Promise<readonly ClaimedRow[]> {
  return withWebhookScope(async (tx) => {
    const candidates = await tx
      .select({
        id: schema.webhookDeliveries.id,
        orgId: schema.webhookDeliveries.orgId,
        webhookId: schema.webhookDeliveries.webhookId,
        attempts: schema.webhookDeliveries.attempts,
      })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.status, 'pending'),
          lt(schema.webhookDeliveries.nextAttemptAt, new Date()),
          lt(schema.webhookDeliveries.attempts, MAX_ATTEMPTS),
        ),
      )
      .orderBy(asc(schema.webhookDeliveries.createdAt))
      .limit(limit);

    const claimed: ClaimedRow[] = [];
    for (const row of candidates) {
      const won = await tx
        .update(schema.webhookDeliveries)
        .set({ attempts: row.attempts + 1, updatedAt: new Date() })
        .where(
          and(
            eq(schema.webhookDeliveries.id, row.id),
            eq(schema.webhookDeliveries.attempts, row.attempts),
            eq(schema.webhookDeliveries.status, 'pending'),
          ),
        )
        .returning({ id: schema.webhookDeliveries.id });

      if (won.length > 0) {
        /* The claim already incremented it — the row the loop hands onward
           must carry THIS attempt's number, or the budget check in
           `markOutcome` sees attempts one behind and dead-lettering never
           fires: a delivery that has actually tried six times is judged by
           the number five and told to back off again, forever. */
        claimed.push({ ...row, attempts: row.attempts + 1 });
      }
    }

    return claimed;
  });
}

/**
 * Loads what the claim role must never see, and makes the request.
 *
 * Every read here is over the ordinary app connection inside `withOrgScope`:
 * the URL, the signing secret, and the payload are the exact three things
 * migration 0049's grants keep away from the role that decides what to
 * deliver — the same claim-only separation the backlinks role has from
 * `docs.page_versions`.
 */
async function deliverOne(deps: DeliveryDeps, row: ClaimedRow): Promise<DeliveryOutcome> {
  return withOrgScope(unsafeAsId<'OrgId'>(row.orgId), async (tx) => {
    const webhookRows = await tx
      .select({
        url: schema.webhooks.url,
        enabled: schema.webhooks.enabled,
        createdBy: schema.webhooks.createdBy,
        signingKeyCiphertext: schema.webhooks.signingKeyCiphertext,
        signingKeyWrapped: schema.webhooks.signingKeyWrapped,
        signingKeyMasterId: schema.webhooks.signingKeyMasterId,
      })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, row.webhookId))
      .limit(1);

    const webhook = webhookRows[0];
    if (webhook === undefined) {
      /* The webhook was deleted; its deliveries cascade with it. The mark is
         a no-op on a row that is gone. */
      return { kind: 'endpoint_disabled' };
    }

    if (!webhook.enabled) {
      /* Disabled between enqueue and delivery. Marked dead WITHOUT a failure:
         a deliberate stop is not the endpoint's wound, and must not count
         toward the auto-disable threshold. */
      return { kind: 'endpoint_disabled' };
    }

    const deliveryRows = await tx
      .select({ payload: schema.webhookDeliveries.payload })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, row.id))
      .limit(1);

    const delivery = deliveryRows[0];
    if (delivery === undefined) return { kind: 'endpoint_disabled' };

    /* Unwrap the per-webhook data key and decrypt the signing secret — the
       mirror of createWebhook's encrypt, sharing `signingAad` so the two
       sides cannot drift (a mismatch fails loud, but only after the receiver
       already stopped trusting us). */
    const dataKey = await deps.keys.unwrapDataKey({
      wrapped: new Uint8Array(webhook.signingKeyWrapped),
      masterKeyId: webhook.signingKeyMasterId,
      encryptionContext: { orgId: row.orgId },
    });
    const secret = decryptString(
      dataKey.key,
      new Uint8Array(webhook.signingKeyCiphertext),
      signingAad(row.orgId, row.webhookId),
    );

    /* The canonical body, byte-identical on every retry — see the file
       header. `JSON.stringify` of the same stored object is deterministic. */
    const body = JSON.stringify(delivery.payload);

    /* Read the platform-wide product name from `platform.branding` — a global
       singleton (no RLS, one row, SELECT only from migration 0073). The
       signature header is derived from it: `x-<slug>-signature`. A missing
       row or NULL product_name falls back to the default. */
    const brandingRows = await tx
      .select({ productName: schema.branding.productName })
      .from(schema.branding)
      .limit(1);
    const productName = brandingRows[0]?.productName ?? DEFAULT_PRODUCT_NAME;
    const signatureHeader = `x-${productName.toLowerCase()}-signature`;

    return deliverWithPerHopGate(deps, webhook.url, body, secret, signatureHeader);
  });
}

/**
 * Makes the POST, re-applying the SSRF gate to every redirect hop.
 *
 * `redirect: 'manual'` is load-bearing: with 'follow', the HTTP client itself
 * would chase a 302 to an internal address after every check here had passed
 * — the whole SSRF bypass in one option. Each hop is re-validated and
 * re-resolved, exactly as §5 requires and unlike `fetchUnfurl`, which refuses
 * redirects outright (the same gate, a different policy, each argued in its
 * own file).
 */
async function deliverWithPerHopGate(
  deps: DeliveryDeps,
  startUrl: string,
  body: string,
  secret: string,
  signatureHeader: string,
): Promise<DeliveryOutcome> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const refusal = await reachabilityRefusal(current, deps.lookup);
    if (refusal !== null) {
      /* The refusal message names the control, never the reason's details —
         a verbose refusal would make this loop a port scanner with readable
         output, the same call unfurl.ts makes. */
      return { kind: 'failed', statusCode: null, error: `refused to connect (${refusal})` };
    }

    const signature = buildWebhookSignature(secret, body);

    let response: Response;
    try {
      response = await deps.fetchImpl(current, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [signatureHeader]: signature,
          /* No cookies, no auth, no referrer — this request must carry
             nothing that would let a third-party server act as, or learn
             about, our users. */
          'user-agent': 'Rinavai-Webhook/1.0',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      /* A timeout, a refused connection, a TLS failure. All the same to the
         retry policy: a transient failure. */
      return {
        kind: 'failed',
        statusCode: null,
        error: error instanceof Error ? error.message : 'the request failed',
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location !== null) {
        current = new URL(location, current).toString();
        continue;
      }
      return {
        kind: 'failed',
        statusCode: response.status,
        error: `receiver answered ${String(response.status)} with no redirect target`,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      return { kind: 'succeeded', statusCode: response.status };
    }

    return {
      kind: 'failed',
      statusCode: response.status,
      error: `receiver answered ${String(response.status)}`,
    };
  }

  return {
    kind: 'failed',
    statusCode: null,
    error: `too many redirects (more than ${String(MAX_REDIRECT_HOPS)})`,
  };
}

/**
 * Whether this URL's host may be connected to, right now.
 *
 * The `outbound-url.ts` two halves, applied to one hop: shape first, then
 * every resolved address. A hostname with one public and one private A record
 * is refused — the attacker controls both records, so "check the first one"
 * is a coin flip with the attacker holding the coin.
 */
async function reachabilityRefusal(
  raw: string,
  lookup: DeliveryDeps['lookup'],
): Promise<string | null> {
  const shape = isAllowedUrl(raw);
  if (!shape.allowed) return shape.reason ?? 'URL refused';

  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIpAddress(host)) {
    return isBlockedAddress(host) ? 'the address is not publicly reachable' : null;
  }

  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch {
    return 'the host could not be resolved';
  }

  if (addresses.length === 0) return 'the host resolves to no addresses';
  if (addresses.some((address) => isBlockedAddress(address))) {
    return 'the host resolves to an address that is not publicly reachable';
  }

  return null;
}

/** Records the outcome of one attempt, as the claim role. */
async function markOutcome(
  deliveryId: string,
  outcome: DeliveryOutcome,
  attempt: number,
): Promise<void> {
  await withWebhookScope(async (tx) => {
    if (outcome.kind === 'succeeded') {
      await tx
        .update(schema.webhookDeliveries)
        .set({
          status: 'succeeded',
          lastStatusCode: outcome.statusCode,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.webhookDeliveries.id, deliveryId));
      return;
    }

    const dead = outcome.kind === 'endpoint_disabled' || attempt >= MAX_ATTEMPTS;

    await tx
      .update(schema.webhookDeliveries)
      .set({
        ...(dead
          ? { status: 'dead' as const }
          : { status: 'pending' as const, nextAttemptAt: backoffFor(attempt) }),
        lastStatusCode: outcome.kind === 'failed' ? outcome.statusCode : null,
        lastError:
          outcome.kind === 'failed'
            ? outcome.error.slice(0, MAX_ERROR_LENGTH)
            : 'endpoint disabled before delivery',
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, deliveryId));
  });
}

/** Exponential backoff, capped — see MAX_ATTEMPTS' comment for the series. */
function backoffFor(attempt: number): Date {
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return new Date(Date.now() + delay);
}

/**
 * A delivery died of failure — count it against the endpoint, and disable the
 * endpoint once it has failed enough.
 *
 * Runs as `taskflow_app` (the claim role holds nothing on `platform.webhooks`).
 * The disable is a conditional `WHERE enabled = true` so two dead deliveries
 * racing cannot double-disable, and the notification's unique
 * `(org_id, subject_id, user_id, kind)` index makes the notification itself
 * idempotent — the same at-least-once discipline as the notification sweeps.
 *
 * The counter is read-modify-write rather than `failure_count = failure_count
 * + 1` in SQL, because raw `sql` is a lint error in feature code and the
 * answer to that ban is a named expression in packages/db — which a one-row
 * update here does not earn. A rare race undercounts by one; the disable
 * still fires.
 */
async function registerFailureAndMaybeDisable(
  row: ClaimedRow,
): Promise<{ readonly disabled: boolean }> {
  return withOrgScope(unsafeAsId<'OrgId'>(row.orgId), async (tx) => {
    const webhookRows = await tx
      .select({
        name: schema.webhooks.name,
        createdBy: schema.webhooks.createdBy,
        failureCount: schema.webhooks.failureCount,
        enabled: schema.webhooks.enabled,
      })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, row.webhookId))
      .limit(1);

    const webhook = webhookRows[0];
    if (webhook === undefined) return { disabled: false };

    /* A webhook disabled between the read and this write — by a person, or by
       a racing dead delivery — must not accrue wound count from deliveries
       that arrived after the stop: `failure_count` is the health read, and the
       disable below is conditional anyway. */
    if (!webhook.enabled) return { disabled: false };

    const failureCount = webhook.failureCount + 1;
    await tx
      .update(schema.webhooks)
      .set({ failureCount, updatedAt: new Date() })
      .where(eq(schema.webhooks.id, row.webhookId));

    if (failureCount < DISABLE_AFTER_FAILURES) {
      return { disabled: false };
    }

    await tx
      .update(schema.webhooks)
      .set({ enabled: false, disabledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.webhooks.id, row.webhookId), eq(schema.webhooks.enabled, true)));

    /* The person who set up the behaviour is the person who can fix it —
       the migration's comment on `created_by`, applied. */
    await tx
      .insert(schema.notifications)
      .values({
        id: newId<'NotificationId'>(),
        orgId: row.orgId,
        userId: webhook.createdBy,
        kind: 'webhook.disabled',
        subjectType: 'webhook',
        subjectId: row.webhookId,
        title: `Webhook disabled: ${webhook.name}`,
        excerpt: `It failed ${String(failureCount)} deliveries in a row.`,
        actorId: null,
      })
      .onConflictDoNothing();

    /* The audit-log fact, emitted by the worker like the notification sweeps
       emit theirs. `actorId: null` is the envelope's documented "the system
       did it" case. */
    await outboxWriter.append(tx, [
      createEvent(
        webhookAutoDisabled,
        { webhookId: row.webhookId, name: webhook.name, failedDeliveries: failureCount },
        /* requestId omitted: the envelope's "the system did it" case, with
           nothing to tie back to. */
        { orgId: unsafeAsId<'OrgId'>(row.orgId), actorId: null },
      ),
    ]);

    return { disabled: true };
  });
}

/** Resolves every A record of a hostname — the default `lookup`. */
async function defaultLookup(hostname: string): Promise<readonly string[]> {
  const result = await dnsLookup(hostname, { all: true });
  return result.map((entry) => entry.address);
}

/**
 * Starts the delivery loop, or does nothing if no webhook connection was
 * configured — the `startAutomationEngine` shape, for the identical reason:
 * a deployment without the claim URL is valid, and what must never happen
 * silently is the narrow claim grant being bypassed by a fallback.
 */
export function startWebhookDeliveryLoop(options: {
  readonly logger: Logger;
  readonly keys: KeyProvider;
  readonly intervalMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
}): { readonly stop: () => void } {
  if (!hasWebhookDatabase()) {
    options.logger.warn(
      'webhook delivery loop not started: DATABASE_WEBHOOK_URL is unset, so queued deliveries will never be sent',
    );
    return { stop: () => undefined };
  }

  const deps: DeliveryDeps = {
    keys: options.keys,
    /* No cast needed: `fetch.bind(globalThis)` is already `typeof fetch`. */
    fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    lookup: options.lookup ?? defaultLookup,
  };

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const result = await drainWebhookDeliveries(deps);
      if (result.processed > 0) {
        options.logger.debug(
          { processed: result.processed, delivered: result.delivered, failed: result.failed },
          'webhook delivery loop drained',
        );
      }
    } catch (error) {
      /* Logged, never rethrown — a transient blip must not take the process
         down, and the rows are still there for the next tick. */
      options.logger.error({ err: error }, 'webhook delivery loop tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
