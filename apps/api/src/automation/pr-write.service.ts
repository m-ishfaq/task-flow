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
  integrationPrFileCommentPosted,
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

/* 'providers' (migration 0109) is what lets `connectedGithubRepo` ->
   `connectorFor` refresh a near-expiry GitHub token transparently before
   any of the functions below ever reach GitHub — the client_id/secret pair
   the refresh call itself needs to authenticate as this deployment's OAuth
   App. */
export type PrWriteDeps = Pick<IntegrationDeps, 'keys' | 'fetchImpl' | 'providers'>;

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

/**
 * `reviewOwnPrHint` is specific to `requestPrChanges`: GitHub refuses to let
 * an account submit a FORMAL review (approve or request changes) on a pull
 * request that same account opened — a real, permanent platform rule, not a
 * transient failure, so no retry of this exact call will ever succeed while
 * the connector's account is also the PR's author. `postPrComment` hits no
 * such restriction (a plain issue comment has no "reviewing yourself" rule),
 * so it gets the generic 422 hint instead of this one — found from a real
 * transcript where the generic hint left the model with an accurate but
 * useless answer: it correctly reported the 422, then had no actionable next
 * step to suggest, and the org's actual need (a documented objection on the
 * PR) had a working path the whole time.
 */
function githubWriteError(
  status: number,
  reviewOwnPrHint = false,
  invalidPositionHint = false,
): Error {
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
  if (status === 422 && reviewOwnPrHint) {
    return errors.serviceUnavailable(
      'GitHub refuses a formal review (request changes or approve) from the same account that ' +
        'opened the pull request — this is a permanent GitHub rule for the connected account, ' +
        'not something that will succeed on retry. Use `pr_post_comment` to leave the feedback ' +
        'as a regular comment instead.',
    );
  }
  /* Specific to `postPrFileComment`: an out-of-range `line` (not part of
     this PR's actual diff) is by far the most likely 422 here, unlike a
     "reviewing your own PR" refusal — GitHub applies no such restriction to
     a plain review comment, only to a formal approve/request-changes. */
  if (status === 422 && invalidPositionHint) {
    return errors.serviceUnavailable(
      "GitHub rejected that — the path or line is not part of this pull request's diff. Use " +
        '`get_pr_files`/`get_pr_file_diff` to confirm the exact path and a real changed line ' +
        'number, or omit `line` to comment on the file as a whole instead.',
    );
  }
  /* 401 means the token itself is dead — revoked, or the OAuth App's own
     secret rotated — never something a retry recovers from, unlike 403
     (a live token that merely lost write access, or transient rate
     limiting). */
  const hint =
    status === 401
      ? ' — the connector token is invalid or was revoked; reconnect the repository ' +
        '(Settings → Automation)'
      : status === 403
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
  input: {
    readonly prNumber: number;
    readonly body: string;
    readonly repoScope?: string | undefined;
  },
): Promise<{ readonly commentId: number | null; readonly providerScope: string }> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
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

/**
 * A comment scoped to one FILE within a pull request — GitHub's own review-
 * comment endpoint, not the general conversation thread `postPrComment`
 * posts to. Needs the PR's HEAD sha first (an extra round trip
 * `pr-read.service.ts`'s `getPullRequestStatus`/`getPullRequestFileContent`
 * already pay for the identical reason: `commit_id` has to name the real
 * commit the comment is anchored to, not whatever the default branch
 * currently holds).
 *
 * `line` is optional and, when omitted, the comment is posted with
 * `subject_type: 'file'` — GitHub's own file-level review comment, with no
 * line at all. This is the DEFAULT rather than something a caller has to
 * ask for on purpose: a line number is only meaningful if it is part of the
 * diff GitHub is currently showing, which the model has no reliable way to
 * confirm without a prior `get_pr_file_diff` call, while "comment on this
 * file" (what a person actually asks for the overwhelming majority of the
 * time) always succeeds. When `line` IS given, `side: 'RIGHT'` pins it to
 * the new (post-change) version of the file — the side a comment about the
 * CURRENT code almost always means; there is no tool-level way to comment
 * on a removed line's own old content, a deliberate, narrower scope than
 * GitHub's own web UI offers.
 */
export async function postPrFileComment(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: {
    readonly prNumber: number;
    readonly path: string;
    readonly body: string;
    readonly line?: number | undefined;
    readonly repoScope?: string | undefined;
  },
): Promise<{
  readonly commentId: number | null;
  readonly path: string;
  readonly providerScope: string;
}> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);

  const prResponse = await fetchFn(
    `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}`,
    { headers: githubHeaders(connector.token), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!prResponse.ok) throw githubWriteError(prResponse.status);
  const prBody: unknown = await prResponse.json();
  if (!isRecord(prBody)) {
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');
  }
  const head = prBody['head'];
  if (!isRecord(head) || typeof head['sha'] !== 'string') {
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');
  }
  const headSha = head['sha'];

  const response = await fetchFn(
    `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(connector.token),
      body: JSON.stringify({
        body: input.body,
        commit_id: headSha,
        path: input.path,
        ...(input.line === undefined
          ? { subject_type: 'file' }
          : { line: input.line, side: 'RIGHT' }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status, false, true);

  const created = await response.json();
  const commentId = isRecord(created) && typeof created['id'] === 'number' ? created['id'] : null;

  // After the effect, never before — see this file's own header.
  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationPrFileCommentPosted,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          prNumber: input.prNumber,
          path: input.path,
          providerCommentId: commentId,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { commentId, path: input.path, providerScope: connector.providerScope };
}

export async function requestPrChanges(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: {
    readonly prNumber: number;
    readonly body: string;
    readonly repoScope?: string | undefined;
  },
): Promise<{ readonly reviewId: number | null; readonly providerScope: string }> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
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
  if (!response.ok) throw githubWriteError(response.status, true);

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

/**
 * The complement `requestPrChanges` never had — an org could ask the
 * assistant to flag problems with a PR but never to formally sign off on
 * one, a real, asymmetric gap found the moment "approve this PR" was tried
 * against the tool list and nothing answered it. Shares `pr:review` (an
 * approval is a review, the identical permission tier
 * `requestPrChanges`/`postPrComment` already sit at) and the identical
 * "own PR" 422 GitHub itself refuses a formal review on.
 */
export async function approvePr(
  actor: AutomationActor,
  deps: PrWriteDeps,
  input: {
    readonly prNumber: number;
    readonly body?: string | undefined;
    readonly repoScope?: string | undefined;
  },
): Promise<{ readonly reviewId: number | null; readonly providerScope: string }> {
  assertMayReview(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}/reviews`,
    {
      method: 'POST',
      headers: githubHeaders(connector.token),
      body: JSON.stringify({
        ...(input.body === undefined ? {} : { body: input.body }),
        event: 'APPROVE',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubWriteError(response.status, true);

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
          event: 'APPROVE',
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
  input: {
    readonly prNumber: number;
    readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
    readonly repoScope?: string | undefined;
  },
): Promise<{
  readonly merged: boolean;
  readonly sha: string | null;
  readonly providerScope: string;
}> {
  assertMayMerge(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
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
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<{ readonly closed: boolean; readonly providerScope: string }> {
  assertMayMerge(actor);
  const orgId = actor.subject.orgId;
  const connector = await connectedGithubRepo(orgId, deps, input.repoScope);
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
