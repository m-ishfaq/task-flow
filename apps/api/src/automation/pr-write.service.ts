import { errors } from '@taskflow/contracts';
import { can } from '@taskflow/policy';
import { outboxWriter, withOrgScope } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import { connectedGithubRepo, type IntegrationDeps } from './integration.service.js';
import { repoPath } from './integration-action.service.js';
import type { AutomationActor } from './automation.service.js';
import {
  integrationPrClosed,
  integrationPrCommentPosted,
  integrationPrMerged,
  integrationPrReviewSubmitted,
} from './integration-events.js';

/**
 * Write access to GitHub pull requests for the AI assistant
 * (ai/phase-15-ai-copilot-and-permissions.md §7, Wave 2 — see that spec's
 * §7.2: "post a review comment, request changes. Merge and close require
 * the confirm step from §4.2").
 *
 * ## Two permissions, not one
 *
 * `pr:review` gates posting a comment and requesting changes — reviewing is
 * a normal part of contributing. `pr:merge` gates merge and close —
 * materially more consequential, and kept as a SEPARATE permission on
 * purpose (`permissions.ts`'s own comment on `GRANTABLE_PERMISSIONS`): an
 * org can let one Member review PRs without also letting them merge/close.
 *
 * ## Authorization is enforced HERE, same reason as `pr-read.service.ts`
 *
 * No tRPC route protects any of these — only the AI tool registry reaches
 * them — so each function checks its own permission first, mirroring
 * `integration-action.service.ts`'s `assertMayManage`.
 *
 * ## Every event is written AFTER the effect, never before
 *
 * Identical discipline to `postSlackMessage`/`createGithubIssue`: the effect
 * is on GitHub, so it cannot share the caller's own transaction the way a
 * card mutation can. Writing the event before a call that might still fail
 * would be a false entry in a hash-chained log — worse than a missing one.
 *
 * ## No comment or review text in any event
 *
 * Same rule `integration-events.ts`'s own "OUTBOUND effects" section states
 * for `integration.message_posted`/`integration.issue_created`: the audit
 * log records that the org posted, where, and under which PR — never what
 * was said, which already lives on GitHub and, for a confirmed tool call,
 * in the assistant's own transcript.
 *
 * ## Every function also returns `providerScope`, unlike a card write tool
 *
 * `card_update`/`card_assign` etc. deliberately do NOT echo `cardId` back —
 * `tool-results.tsx`'s own renderer reads it from the tool CALL's `input`
 * instead, since the model already put it there. A PR write tool cannot do
 * the same for the repository: `providerScope` (`owner/repo`) is resolved
 * server-side and never appears anywhere in the model's own input, so
 * there is nothing for a renderer to read off the call — returning it here
 * is what lets the frontend build a real `https://github.com/<scope>/pull/
 * <n>` link, not optional enrichment.
 */

export type PrWriteDeps = Pick<IntegrationDeps, 'keys' | 'fetchImpl'>;

const TIMEOUT_MS = 10_000;

function assertMayReview(actor: AutomationActor): void {
  if (!can(actor.subject, 'pr:review').allowed) {
    throw errors.forbidden('You do not have permission to review pull requests.');
  }
}

function assertMayMerge(actor: AutomationActor): void {
  if (!can(actor.subject, 'pr:merge').allowed) {
    throw errors.forbidden('You do not have permission to merge or close pull requests.');
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

function githubWriteError(status: number): Error {
  if (status === 404) {
    return errors.notFound('That pull request does not exist, or the connector cannot see it.');
  }
  if (status === 405) {
    return errors.serviceUnavailable('GitHub reports that pull request is not mergeable.');
  }
  if (status === 409) {
    return errors.serviceUnavailable(
      'GitHub could not complete that — the head branch changed since it was last checked.',
    );
  }
  const hint =
    status === 403
      ? ' — the connector token no longer has write access, or GitHub is rate limiting'
      : status === 422
        ? ' — GitHub rejected the request (e.g. you cannot review your own pull request)'
        : '';
  return errors.serviceUnavailable(`GitHub answered ${String(status)}${hint}.`);
}

function envelopeOf(actor: AutomationActor) {
  return {
    orgId: actor.subject.orgId,
    actorId: actor.subject.userId,
    requestId: actor.requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function postPrComment(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: { readonly prNumber: number; readonly body: string },
): Promise<{ readonly commentId: number | null; readonly providerScope: string }> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/issues/${String(input.prNumber)}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(connector.token),
      body: JSON.stringify({ body: input.body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status);

  const created = await response.json();
  const commentId = isRecord(created) && typeof created['id'] === 'number' ? created['id'] : null;

  // After the effect, never before — see this file's own header.
  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationPrCommentPosted,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          prNumber: input.prNumber,
          providerCommentId: commentId,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { commentId, providerScope: connector.providerScope };
}

export async function requestPrChanges(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: { readonly prNumber: number; readonly body: string },
): Promise<{ readonly reviewId: number | null; readonly providerScope: string }> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}/reviews`,
    {
      method: 'POST',
      headers: githubHeaders(connector.token),
      body: JSON.stringify({ body: input.body, event: 'REQUEST_CHANGES' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status);

  const created = await response.json();
  const reviewId = isRecord(created) && typeof created['id'] === 'number' ? created['id'] : null;

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationPrReviewSubmitted,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          prNumber: input.prNumber,
          event: 'REQUEST_CHANGES',
          providerReviewId: reviewId,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { reviewId, providerScope: connector.providerScope };
}

export async function mergePr(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: { readonly prNumber: number; readonly mergeMethod?: 'merge' | 'squash' | 'rebase' },
): Promise<{
  readonly merged: boolean;
  readonly sha: string | null;
  readonly providerScope: string;
}> {
  assertMayMerge(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}/merge`,
    {
      method: 'PUT',
      headers: githubHeaders(connector.token),
      body: JSON.stringify(
        input.mergeMethod === undefined ? {} : { merge_method: input.mergeMethod },
      ),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status);

  const result = await response.json();
  const merged = isRecord(result) && result['merged'] === true;
  const sha = isRecord(result) && typeof result['sha'] === 'string' ? result['sha'] : null;

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationPrMerged,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          prNumber: input.prNumber,
          sha,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { merged, sha, providerScope: connector.providerScope };
}

export async function closePr(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: { readonly prNumber: number },
): Promise<{ readonly closed: boolean; readonly providerScope: string }> {
  assertMayMerge(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}`,
    {
      method: 'PATCH',
      headers: githubHeaders(connector.token),
      body: JSON.stringify({ state: 'closed' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status);

  const result = await response.json();
  const closed = isRecord(result) && result['state'] === 'closed';

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationPrClosed,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          prNumber: input.prNumber,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { closed, providerScope: connector.providerScope };
}
