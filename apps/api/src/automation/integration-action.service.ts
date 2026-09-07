import { outboxWriter, withOrgScope } from '@taskflow/db';
import { errors } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { can } from '@taskflow/policy';
import { connectorFor, type IntegrationDeps } from './integration.service.js';
import { integrationIssueCreated, integrationMessagePosted } from './integration-events.js';
import type { AutomationActor } from './automation.service.js';

/**
 * The OUTBOUND connector actions (ai/phase-10-automation.md §7.6, slice 4).
 *
 * ⚠ This is the first automation action that spends the ORG'S OWN IDENTITY on a
 * platform this deployment does not run. A message posted here is signed by the
 * workspace's bot; an issue opened here is attributed to the connecting user's
 * token. Nothing about it is undoable from this side.
 *
 * ## Authorization is enforced HERE, at execution, not by a route
 *
 * There is no HTTP boundary — the caller is the worker's executor, running as
 * the rule owner re-resolved on every execution (executor.ts §2). So the
 * `integration:manage` check lives in this function, the
 * `enqueueWebhookDelivery` precedent applied to an action with no route. A
 * member who cannot manage integrations cannot write a rule that speaks as the
 * org, and demoting them stops their existing rules on the next execution
 * rather than at some token expiry.
 *
 * `integration:manage` is org-level (§9 decision 4), so it is a single
 * no-target `can()` — a relationship tuple cannot satisfy it, which is the
 * property that makes the one-line check sufficient.
 *
 * ## The connector is named by ROW ID; nothing about the destination is free text
 *
 * The `call_webhook` rule, applied to a second provider: an action names an
 * org-registered connector, never a URL and never a repository string. The
 * repository comes off the row's own `provider_scope`, so a rule cannot post an
 * issue to a repo the org did not connect even though the stored token would
 * very often reach it. Only Slack's `channel` is a rule input, because a
 * workspace has many channels and the connector is the workspace.
 *
 * ## Two hostnames, both literals in this file
 *
 * `slack.com` and `api.github.com` are written here and are not derived from
 * anything stored or received. That is why there is no SSRF gate on this path
 * and why its absence is not an omission: `outbound-url.ts` exists to decide
 * whether the server may fetch a URL A USER TYPED, and no user string reaches
 * these URLs. The one stored value that touches a URL at all is the repository
 * scope, and it is checked against a strict shape before it is interpolated —
 * see `repoPath`.
 */

/**
 * What an outbound action needs: the key provider (to unwrap the org's data key
 * and decrypt the credential) and a fetch to make the call with.
 *
 * Deliberately NARROWER than `IntegrationDeps`. The OAuth flow needs client
 * secrets, a redirect URI and the JWT secret; none of that is required to post
 * a message, and handing the worker a struct full of client secrets it has no
 * use for is how a process ends up holding credentials nobody meant to give it.
 */
export type IntegrationActionDeps = Pick<IntegrationDeps, 'keys' | 'fetchImpl'>;

/** Slack and GitHub both answer fast or not at all; a rule must not hang the run loop. */
const TIMEOUT_MS = 10_000;

/**
 * How much of a provider's error body to keep.
 *
 * Bounded because it lands in `automation_runs.action_results`, which is read
 * back into a UI. Slack and GitHub both return small JSON errors; a redirect to
 * an HTML page would not be.
 */
const MAX_ERROR_LENGTH = 300;

export async function postSlackMessage(
  actor: AutomationActor,
  deps: IntegrationActionDeps,
  input: {
    readonly integrationId: string;
    readonly channel: string;
    readonly text: string;
  },
): Promise<{ readonly providerMessageId: string | null }> {
  assertMayManage(actor);
  const orgId = actor.subject.orgId;

  const connector = await connectorFor(orgId, deps, input.integrationId, 'slack');
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connector.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: input.channel, text: input.text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw errors.serviceUnavailable(`Slack answered ${String(response.status)}.`);
  }

  /* Slack answers HTTP 200 with `{ ok: false, error: ... }` for every
     application-level failure — a channel the bot is not in, an archived
     channel, a revoked token. Checking only `response.ok` would record every
     one of those as a SUCCEEDED action while nothing was posted, which is the
     worst outcome available: a rule that reports working and does nothing. */
  const body = (await response.json()) as { ok?: unknown; error?: unknown; ts?: unknown };
  if (body.ok !== true) {
    /* Slack's own code is carried through, the `TwilioApiError` lesson: a
       generic refusal makes `not_in_channel`, `channel_not_found` and
       `token_revoked` — three different fixes — look like one problem. The
       codes are a published enumeration and echo no message content. */
    throw errors.serviceUnavailable(
      `Slack refused the message: ${truncate(typeof body.error === 'string' ? body.error : 'unknown error')}`,
    );
  }

  const providerMessageId = typeof body.ts === 'string' ? body.ts : null;

  /* Guardrail 11, and the effect ALREADY HAPPENED. Unlike every card action,
     this event cannot be written in the same transaction as its effect — the
     effect is on Slack. So it is written after a confirmed success and never
     before: an event claiming a post that Slack refused would be a false entry
     in a hash-chained log, which is worse than a missing one. */
  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationMessagePosted,
        {
          integrationId: input.integrationId,
          provider: 'slack',
          providerScope: connector.providerScope,
          channel: input.channel,
          providerMessageId,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { providerMessageId };
}

export async function createGithubIssue(
  actor: AutomationActor,
  deps: IntegrationActionDeps,
  input: {
    readonly integrationId: string;
    readonly title: string;
    readonly body: string;
  },
): Promise<{ readonly issueNumber: number | null }> {
  assertMayManage(actor);
  const orgId = actor.subject.orgId;

  const connector = await connectorFor(orgId, deps, input.integrationId, 'github');
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/issues`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connector.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: input.title, body: input.body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    /* 410 is the one worth naming: GitHub answers it when Issues are DISABLED
       on the repository, which reads as a permissions problem and is not one.
       403 covers both "the token lost access" and secondary rate limiting. */
    const hint =
      response.status === 410
        ? ' — Issues are disabled on that repository'
        : response.status === 403
          ? ' — the connector token no longer has write access, or GitHub is rate limiting'
          : '';
    throw errors.serviceUnavailable(`GitHub answered ${String(response.status)}${hint}.`);
  }

  const created = (await response.json()) as { number?: unknown };
  const issueNumber = typeof created.number === 'number' ? created.number : null;

  // After the effect, never before — see `postSlackMessage`.
  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationIssueCreated,
        {
          integrationId: input.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          issueNumber,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { issueNumber };
}

function assertMayManage(actor: AutomationActor): void {
  if (!can(actor.subject, 'integration:manage').allowed) {
    throw errors.forbidden(
      'Only members who can manage integrations may make a rule act as the organization.',
    );
  }
}

const envelopeOf = (actor: AutomationActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

/**
 * The `owner/name` segment of a GitHub API path, refused unless it is exactly
 * that shape.
 *
 * This value comes off the connector row, where `selectRepo` wrote it after
 * checking it against GitHub's own list — so it is not attacker-controlled
 * today. The check is here because the value is INTERPOLATED INTO A URL PATH,
 * and the consequence of that assumption ever being wrong is not a bad request:
 * `owner/../../user/repos` reaches a different endpoint on the same host with
 * the org's token attached, turning "open an issue on our repo" into an
 * arbitrary GitHub API call. A path segment built from storage should be
 * checked by the code that builds the path, not by the code that filled the
 * column three slices ago.
 *
 * `encodeURIComponent` is not the fix on its own: it would encode the legitimate
 * separating slash too, producing `owner%2Fname` and a 404 on every call. The
 * shape check is what allows the slash to stay literal.
 *
 * Exported so `pr-read.service.ts` (Phase 15 §7 Wave 1) reuses the identical
 * guard rather than re-implementing the same path-traversal check a third
 * time — every place a `provider_scope` value is interpolated into a GitHub
 * URL path needs it, not just this file's own outbound actions.
 */
export function repoPath(providerScope: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(providerScope)) {
    throw errors.validation({
      integrationId: 'That connector is not bound to a valid repository.',
    });
  }
  return providerScope;
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH - 1)}…` : value;
}
