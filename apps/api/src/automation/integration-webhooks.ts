import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unsafeAsId, type KeyProvider, type OrgId } from '@taskflow/contracts';
import { and, eq, outboxWriter, resolveIntegrationOrg, schema, withOrgScope } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import { decryptString, verifyGitHubSignature, verifySlackSignature } from '@taskflow/security';
import { integrationGithubEvent, integrationSlackEvent } from './integration-events.js';
import { integrationTokenAad } from './integration.service.js';

/**
 * Inbound connector webhooks (ai/phase-10-automation.md §7.3–§7.5, Wave 4
 * slice 3).
 *
 * ⚠ Human-review surface (CLAUDE.md §2.2 — "any webhook signature
 * verification"). Read this file like the telephony webhook: the signature is
 * the only proof of legitimacy, the order of operations IS the control, and
 * the response to every rejection is the same terse status with no detail.
 *
 * ## Plain Fastify routes, not tRPC procedures
 *
 * The caller is Slack or GitHub — a third party with no session, exactly like
 * the telephony carrier. The tRPC adapter replaces the JSON parser globally
 * with a pass-through, which is what makes these handlers work at all: the
 * signature covers the EXACT bytes the provider sent, so `request.body`
 * arrives here as the raw string and is verified before anything parses it.
 * A handler that re-serialized JSON before verifying would fail every request
 * — and that failure mode is the shape of bug that gets "fixed" by skipping
 * verification for a path.
 *
 * ## Two providers, two resolution orders — the difference IS the control
 *
 * - **Slack** (§7.4): the signing secret is deployment-wide, so verification
 *   comes FIRST and `team_id` from the VERIFIED body is a lookup key, never a
 *   trust input — the telephony webhook's `AccountSid` order. No row → 404.
 *   That 404 is safe BECAUSE of the order: only a request that already passed
 *   signature verification can reach the lookup, so it reveals nothing to an
 *   attacker who lacks the signing secret. The replay control is the
 *   five-minute freshness window inside `verifySlackSignature`; there is no
 *   dedupe row (migration 0058's CHECK says the dedupe table is GitHub-only).
 * - **GitHub**: the verify secret is PER-ORG, so the org is resolved from
 *   `repository.full_name` in the UNVERIFIED body (a lookup key — it selects
 *   WHICH KEY to check), then the signature is verified against that org's
 *   stored secret. Because the lookup runs before any verification, its
 *   outcome would be a probe oracle to an unauthenticated attacker — so EVERY
 *   GitHub refusal after a parseable body answers the same 403: unknown repo,
 *   revoked row, wrong secret, and replay are indistinguishable (the telephony
 *   webhook's uniform-403 rule, applied where the order forces it). Only
 *   malformed requests answer 400, and they carry no repo to probe with.
 *   `X-GitHub-Delivery` is the replay control: one row in
 *   `platform.integration_deliveries`, written on SUCCESS inside the handler's
 *   own transaction — a failed attempt rolls the row back and GitHub's retry
 *   (same delivery id) proceeds normally.
 *
 * ## What a verified event becomes
 *
 * A synthetic trigger in the org's outbox: `integration.slack_event` /
 * `integration.github_event` carrying `{ providerScope, providerEvent,
 * payload }` (§7.5). The envelope's `actorId` is null — the event came from
 * Slack/GitHub, not from a user, and the null-is-the-system convention says
 * exactly that. The engine fires any rule keyed on the event; a rule with a
 * card action records a failed run (`cardIdOf` refuses the missing cardId),
 * which is the designed behaviour for a trigger that carries no card.
 */

export interface IntegrationWebhookDeps {
  /** The same provider that wraps connector credentials — unwraps GitHub verify secrets. */
  readonly keys: KeyProvider;
  /**
   * The Slack app's signing secret. Absent = the Slack route answers 503:
   * fail-closed. A request that cannot be verified must not be processed,
   * and there is no URL to "verify against nothing" with.
   */
  readonly slackSigningSecret: string | undefined;
}

export function registerIntegrationWebhooks(
  app: FastifyInstance,
  deps: IntegrationWebhookDeps,
): void {
  /**
   * A Slack workspace event (or the app-configuration handshake).
   *
   * Verification is deployment-wide and comes before ANY parse: the
   * signature over `v0:<timestamp>:<raw body>` is the assertion, and the
   * body's `team_id` — read only after the signature passes — selects the
   * org. `url_verification` is the one body with no org at all: it is Slack
   * asking "is this endpoint live?" while configuring the app, and the
   * answer is the challenge echoed back after the signature passes. It must
   * NOT emit an event.
   */
  app.post('/integrations/slack', async (request, reply) => {
    const signingSecret = deps.slackSigningSecret;
    if (signingSecret === undefined || signingSecret.length === 0) {
      /* Unconfigured deployment. Fail-closed rather than processing a
         request whose signature cannot be checked. */
      return reply.status(503).send();
    }

    const body = rawBody(request);
    if (body === undefined) return reply.status(400).send();

    const signature = request.headers['x-slack-signature'];
    const timestamp = request.headers['x-slack-request-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      /* Reject unsigned. Checked before the parse — an unauthenticated
         endpoint that parses before authenticating is a work-doer for
         strangers. */
      return reply.status(403).send();
    }

    const valid = verifySlackSignature({
      signature,
      timestamp,
      body,
      signingSecret,
    });
    if (!valid) return reply.status(403).send();

    const parsed = parseJsonBody(body);
    if (parsed === undefined) return reply.status(400).send();
    const payload = parsed as Record<string, unknown>;

    /* The url_verification handshake — app-level, no org involved. Echoing
       the challenge after a verified signature is the entire answer. */
    if (payload['type'] === 'url_verification') {
      if (typeof payload['challenge'] !== 'string') return reply.status(400).send();
      return reply.type('text/plain').send(payload['challenge']);
    }

    const teamId = typeof payload['team_id'] === 'string' ? payload['team_id'] : undefined;
    if (teamId === undefined || teamId.length === 0) return reply.status(400).send();

    const orgId = await resolveIntegrationOrg('slack', teamId);
    if (orgId === undefined) return reply.status(404).send();

    /* The event type a rule keys on: Slack nests it as `event.type` for
       event_callback bodies and puts it top-level otherwise. */
    const eventType =
      stringField(payload['event'], 'type') ?? stringField(payload, 'type') ?? 'unknown';

    const outcome = await emitSlackTrigger({
      orgId,
      teamId,
      eventType,
      payload: slackPayloadForStorage(payload),
      requestId: request.id,
    });
    if (outcome === 'not_connected') {
      /* The workspace's connector is disconnected or gone — same 404 as no
         row, so the two are indistinguishable to Slack (and to anyone
         probing which team_ids exist). */
      return reply.status(404).send();
    }
    return reply.status(204).send();
  });

  /**
   * A GitHub repository event.
   *
   * The reverse resolution order: `repository.full_name` from the UNVERIFIED
   * body selects the org (a lookup key — it chooses the per-org secret to
   * check), and only after that signature passes is anything written.
   * `X-GitHub-Delivery` dedupes on SUCCESS in the handler's own transaction,
   * so a replayed delivery answers 403 having written nothing.
   */
  app.post('/integrations/github', async (request, reply) => {
    const body = rawBody(request);
    if (body === undefined) return reply.status(400).send();

    const deliveryId = request.headers['x-github-delivery'];
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      /* No delivery id means no replay control — refuse before the parse. */
      return reply.status(400).send();
    }

    const parsed = parseJsonBody(body);
    if (parsed === undefined) return reply.status(400).send();
    const payload = parsed as Record<string, unknown>;

    const fullName = stringField(payload['repository'], 'full_name');
    if (fullName === undefined || fullName.length === 0) {
      /* A payload carrying no recognizable repo is refused, never silently
         dropped (§7.4). 400, not 403: a body with no repo at all — GitHub's
         `ping` event is the canonical example — cannot be a probe of which
         repos are connected, so it reveals nothing and answers as the
         malformed request it is. GitHub's dashboard shows the failure either
         way, which is the useful place for it to appear. */
      return reply.status(400).send();
    }

    const orgId = await resolveIntegrationOrg('github', fullName);
    /* Uniform 403, not 404: this lookup runs BEFORE verification, so its
       outcome is observable to an unauthenticated attacker — distinguishing
       "no such repo" from "repo exists, wrong secret" would hand them a
       probe oracle for which repos the deployment's orgs have connected.
       Same response for unknown, revoked, and wrong-secret. */
    if (orgId === undefined) return reply.status(403).send();

    /* Load the connector under the ORG scope: the row id (the AAD binds the
       verify secret to org+row), its status, and the encrypted secret. A
       row that is not a live connector — disconnected, or revoked (verify
       columns wiped by 0057) — is the same 403 as an unknown one. */
    const loaded = await loadGithubVerify(orgId, fullName, deps.keys);
    if (loaded === undefined) return reply.status(403).send();

    const signature = request.headers['x-hub-signature-256'];
    const valid = verifyGitHubSignature({
      signature: typeof signature === 'string' ? signature : '',
      body,
      secret: loaded.secret,
    });
    if (!valid) return reply.status(403).send();

    const eventHeader = request.headers['x-github-event'];
    const eventType = typeof eventHeader === 'string' ? eventHeader : 'unknown';

    const outcome = await withOrgScope(orgId, async (tx) => {
      /* The dedupe row, written FIRST in the same transaction as the event:
         a replayed delivery must leave no trace, and a failed emission rolls
         the dedupe row back so GitHub's retry can still land. */
      const claimed = await tx
        .insert(schema.integrationDeliveries)
        .values({ orgId, provider: 'github', deliveryId })
        .onConflictDoNothing({
          target: [
            schema.integrationDeliveries.orgId,
            schema.integrationDeliveries.provider,
            schema.integrationDeliveries.deliveryId,
          ],
        })
        .returning({ orgId: schema.integrationDeliveries.orgId });

      if (claimed.length === 0) return 'replayed' as const;

      await outboxWriter.append(tx, [
        createEvent(
          integrationGithubEvent,
          { providerScope: fullName, providerEvent: eventType, payload: parsed },
          { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(request.id) },
        ),
      ]);
      return 'emitted' as const;
    });

    if (outcome === 'replayed') return reply.status(403).send();
    return reply.status(204).send();
  });
}

/** The one emittable Slack outcome — or why the route answers 404. */
type SlackEmission = 'emitted' | 'not_connected';

/**
 * Loads the org-scoped connector row, checks it is live, and appends the
 * synthetic trigger — all in one transaction, so the event and its guard
 * commit or roll back together.
 */
async function emitSlackTrigger(input: {
  readonly orgId: OrgId;
  readonly teamId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly requestId: string;
}): Promise<SlackEmission> {
  return withOrgScope(input.orgId, async (tx) => {
    const rows = await tx
      .select({ status: schema.integrations.status })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.orgId, input.orgId),
          eq(schema.integrations.provider, 'slack'),
          eq(schema.integrations.providerScope, input.teamId),
        ),
      )
      .limit(1);

    /* The status guard is the one place a disconnect stops inbound Slack
       traffic: verification is deployment-wide (nothing per-org to fail
       with), so without this check a revoked workspace's events would keep
       flowing after the org disconnected. Same 404 as no row. */
    if (rows[0]?.status !== 'connected') {
      return 'not_connected' as const;
    }

    await outboxWriter.append(tx, [
      createEvent(
        integrationSlackEvent,
        {
          providerScope: input.teamId,
          providerEvent: input.eventType,
          payload: input.payload,
        },
        { orgId: input.orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(input.requestId) },
      ),
    ]);
    return 'emitted' as const;
  });
}

/** Loads and decrypts the GitHub connector's verify secret, or undefined. */
async function loadGithubVerify(
  orgId: OrgId,
  fullName: string,
  keys: KeyProvider,
): Promise<{ readonly secret: string } | undefined> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.integrations.id,
        status: schema.integrations.status,
        verifyCiphertext: schema.integrations.verifyCiphertext,
        verifyWrapped: schema.integrations.verifyWrapped,
        verifyMasterId: schema.integrations.verifyMasterId,
      })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.orgId, orgId),
          eq(schema.integrations.provider, 'github'),
          eq(schema.integrations.providerScope, fullName),
        ),
      )
      .limit(1);

    const row = rows[0];
    /* A pending (login-keyed) or revoked row never matches a repo full_name;
       the status and null guards are the honest refusal when one somehow
       does — a connector that is not live has no secret to verify with. */
    if (row?.status !== 'connected') return undefined;
    if (
      row.verifyCiphertext === null ||
      row.verifyWrapped === null ||
      row.verifyMasterId === null
    ) {
      return undefined;
    }

    const dataKey = await keys.unwrapDataKey({
      wrapped: new Uint8Array(row.verifyWrapped),
      masterKeyId: row.verifyMasterId,
      encryptionContext: { orgId },
    });

    return {
      secret: decryptString(
        dataKey.key,
        new Uint8Array(row.verifyCiphertext),
        integrationTokenAad(orgId, row.id),
      ),
    };
  });
}

/**
 * The raw request body as the EXACT bytes the provider signed.
 *
 * The tRPC adapter's global JSON pass-through means `request.body` is the
 * raw string for `application/json`. Anything else (a body a different
 * parser already turned into an object) is refused: re-serializing would
 * not reproduce the signed bytes.
 */
function rawBody(request: FastifyRequest): string | undefined {
  return typeof request.body === 'string' ? request.body : undefined;
}

/** Parses the raw body, or undefined when it is not JSON at all. */
function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads a string field off a nested JSON value, or undefined. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === 'string' ? record[key] : undefined;
}

/**
 * The one deliberate edit before a Slack body is stored: the deprecated
 * legacy `token` field is a shared secret that would otherwise sit in every
 * consumer's view of the outbox. Dropped here, after verification — the
 * signature was checked against the UNEDITED bytes above, so the stored copy
 * is allowed to differ.
 */
function slackPayloadForStorage(payload: Record<string, unknown>): unknown {
  if (!('token' in payload)) return payload;
  const copy = { ...payload };
  delete copy['token'];
  return copy;
}
