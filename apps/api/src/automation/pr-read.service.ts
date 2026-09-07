import { errors } from '@taskflow/contracts';
import { can } from '@taskflow/policy';
import {
  connectedGithubRepo,
  connectedGithubRepos,
  type IntegrationDeps,
} from './integration.service.js';
import { repoPath } from './integration-action.service.js';
import type { AutomationActor } from './automation.service.js';

/**
 * Read-only GitHub pull-request access for the AI assistant
 * (ai/phase-15-ai-copilot-and-permissions.md §7 — Wave 1 shipped three read
 * tools and one permission; Wave 3 adds `repoScope` and `list_repos` for
 * organizations with more than one connected repo, per the real gap found
 * once a second repo actually got connected: `connectedGithubRepo` used to
 * silently pick the most-recently-connected one with nothing telling
 * anyone a repo other than the intended one was now in use).
 *
 * ## Authorization is enforced HERE, not by a route
 *
 * These functions have no tRPC route of their own in this wave — the only
 * caller is `apps/api/src/ai/tools/pr.ts`'s tool registry, and a tool call
 * bypasses every route. `assertMayView` is the identical shape
 * `integration-action.service.ts`'s `assertMayManage` already established
 * for the same reason: a function with no HTTP boundary has to check itself.
 *
 * ## `repoScope` is caller-supplied, but never trusted blindly
 *
 * Every function still resolves the repo through `connectedGithubRepo` and
 * reads `repoPath(providerScope)` off THAT row — an explicit `repoScope`
 * input is checked against the org's own list of CONNECTED repos before it
 * is ever used to build a URL, exactly as before; a string naming a repo
 * this org never connected is refused with `NOT_FOUND`, the identical
 * refusal an omitted scope on a single-repo org already gets. What changed
 * is that a caller now MAY name which of several connected repos to use —
 * never that an arbitrary string reaches GitHub unchecked.
 */

export type PrReadDeps = Pick<IntegrationDeps, 'keys' | 'fetchImpl'>;

const TIMEOUT_MS = 10_000;
const MAX_LIST_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 10;
/* ~5k tokens — real input-size hygiene, the same role `search.query`'s own
   result cap and `ChatSendInput.messages`'s 40-element cap play elsewhere in
   this registry, not a product decision about how much of a diff a person
   may see (they can still open the PR in a browser). A truncated diff is
   marked BOTH structurally (`truncated: boolean`) and in the text itself, so
   the model can tell the person their diff was cut off without having to
   reason about the boolean alone. */
const MAX_DIFF_CHARS = 20_000;
const MAX_COMMENTS = 30;
const MAX_FILES = 50;

export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly baseBranch: string;
  readonly headBranch: string;
}

export interface PrComment {
  readonly id: number;
  /** `'general'` = the PR's own conversation thread (the Issues API);
      `'review'` = an inline code-review comment (the Pulls API) — GitHub
      splits these across two endpoints, and a real "what did reviewers say"
      question needs both. */
  readonly kind: 'general' | 'review';
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly path: string | null;
  readonly url: string;
}

export interface PrFile {
  readonly path: string;
  /** GitHub's own vocabulary: `added` / `removed` / `modified` / `renamed`
      / `copied` / `changed` / `unchanged`. Passed through verbatim rather
      than narrowed to a closed union — a value this codebase does not
      generate and only ever displays does not need the same "reject the
      unknown" discipline a real input boundary does. */
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly previousPath: string | null;
}

function assertMayView(actor: AutomationActor): void {
  if (!can(actor.subject, 'pr:view').allowed) {
    throw errors.forbidden('You do not have permission to view pull requests.');
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

function githubReadError(status: number): Error {
  if (status === 404) {
    return errors.notFound('That pull request does not exist, or the connector cannot see it.');
  }
  const hint =
    status === 403 ? ' — the connector token no longer has access, or GitHub is rate limiting' : '';
  return errors.serviceUnavailable(`GitHub answered ${String(status)}${hint}.`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPrSummary(raw: unknown): PrSummary | null {
  if (!isRecord(raw)) return null;
  const number = raw['number'];
  const title = raw['title'];
  const state = raw['state'];
  const createdAt = raw['created_at'];
  const updatedAt = raw['updated_at'];
  const url = raw['html_url'];
  const user = raw['user'];
  const base = raw['base'];
  const head = raw['head'];
  if (
    typeof number !== 'number' ||
    typeof title !== 'string' ||
    typeof state !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof url !== 'string' ||
    !isRecord(base) ||
    !isRecord(head)
  ) {
    return null;
  }
  return {
    number,
    title,
    state,
    isDraft: raw['draft'] === true,
    author: isRecord(user) ? stringOrNull(user['login']) : null,
    url,
    createdAt,
    updatedAt,
    baseBranch: stringOrNull(base['ref']) ?? '',
    headBranch: stringOrNull(head['ref']) ?? '',
  };
}

function toComment(raw: unknown, kind: PrComment['kind']): PrComment | null {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const body = raw['body'];
  const createdAt = raw['created_at'];
  const url = raw['html_url'];
  const user = raw['user'];
  if (
    typeof id !== 'number' ||
    typeof body !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof url !== 'string'
  ) {
    return null;
  }
  return {
    id,
    kind,
    author: isRecord(user) ? stringOrNull(user['login']) : null,
    body,
    createdAt,
    path: stringOrNull(raw['path']),
    url,
  };
}

export async function listPullRequests(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: {
    readonly state?: 'open' | 'closed' | 'all';
    readonly limit?: number;
    readonly repoScope?: string | undefined;
  },
): Promise<readonly PrSummary[]> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const state = input.state ?? 'open';
  const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls` +
      `?state=${state}&per_page=${String(limit)}&sort=created&direction=desc`,
    { headers: githubHeaders(connector.token), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!response.ok) throw githubReadError(response.status);

  const body = (await response.json()) as unknown[];
  return body.map(toPrSummary).filter((pr): pr is PrSummary => pr !== null);
}

export async function getPullRequestDiff(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<{ readonly prNumber: number; readonly truncated: boolean; readonly diff: string }> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}`,
    {
      headers: { ...githubHeaders(connector.token), accept: 'application/vnd.github.v3.diff' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw githubReadError(response.status);

  const raw = await response.text();
  const truncated = raw.length > MAX_DIFF_CHARS;
  const diff = truncated
    ? `${raw.slice(0, MAX_DIFF_CHARS)}\n\n… [diff truncated at ${String(MAX_DIFF_CHARS)} characters; ${String(raw.length - MAX_DIFF_CHARS)} more characters omitted]`
    : raw;

  return { prNumber: input.prNumber, truncated, diff };
}

export async function getPullRequestComments(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<readonly PrComment[]> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);
  const headers = githubHeaders(connector.token);

  const [issueRes, reviewRes] = await Promise.all([
    fetchFn(
      `https://api.github.com/repos/${repo}/issues/${String(input.prNumber)}/comments?per_page=${String(MAX_COMMENTS)}`,
      { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
    ),
    fetchFn(
      `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}/comments?per_page=${String(MAX_COMMENTS)}`,
      { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
    ),
  ]);
  if (!issueRes.ok) throw githubReadError(issueRes.status);
  if (!reviewRes.ok) throw githubReadError(reviewRes.status);

  const issueComments = ((await issueRes.json()) as unknown[])
    .map((c) => toComment(c, 'general'))
    .filter((c): c is PrComment => c !== null);
  const reviewComments = ((await reviewRes.json()) as unknown[])
    .map((c) => toComment(c, 'review'))
    .filter((c): c is PrComment => c !== null);

  return [...issueComments, ...reviewComments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, MAX_COMMENTS);
}

/**
 * Every GitHub repo connected for the org — the tool this file's own header
 * says `repoScope`'s ambiguity refusal points a caller at. No GitHub call:
 * `connectedGithubRepos` reads straight off `platform.integrations`, so
 * this answers "what CAN I pick from" without spending a request against a
 * repo that has not been chosen yet.
 */
export async function listConnectedRepos(
  actor: AutomationActor,
): Promise<readonly { readonly providerScope: string }[]> {
  assertMayView(actor);
  const rows = await connectedGithubRepos(actor.subject.orgId);
  return rows.map((row) => ({ providerScope: row.providerScope }));
}

function toFile(raw: unknown): PrFile | null {
  if (!isRecord(raw)) return null;
  const filename = raw['filename'];
  const status = raw['status'];
  const additions = raw['additions'];
  const deletions = raw['deletions'];
  if (
    typeof filename !== 'string' ||
    typeof status !== 'string' ||
    typeof additions !== 'number' ||
    typeof deletions !== 'number'
  ) {
    return null;
  }
  return {
    path: filename,
    status,
    additions,
    deletions,
    previousPath: stringOrNull(raw['previous_filename']),
  };
}

/**
 * The files a PR touches — path, status (added/modified/removed/renamed),
 * and the additions/deletions count per file. A real gap `get_pr_diff`
 * alone left open: a diff answers "what changed, line by line," which is
 * the wrong shape for "which files does this PR touch" — a large PR's diff
 * routinely blows past `MAX_DIFF_CHARS` before a person ever learns the
 * SHAPE of the change, where the files list is one page regardless of PR
 * size.
 */
export async function getPullRequestFiles(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<readonly PrFile[]> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn(
    `https://api.github.com/repos/${repoPath(connector.providerScope)}/pulls/${String(input.prNumber)}/files?per_page=${String(MAX_FILES)}`,
    { headers: githubHeaders(connector.token), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!response.ok) throw githubReadError(response.status);

  const body = (await response.json()) as unknown[];
  return body.map(toFile).filter((file): file is PrFile => file !== null);
}
