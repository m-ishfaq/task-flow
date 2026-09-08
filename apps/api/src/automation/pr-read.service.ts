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
/**
 * Mirrors `router.ts`'s `ChatMessage` `tool_result` variant's own
 * `content: z.string().max(20_000)` — the hard ceiling `execute()`'s whole
 * `JSON.stringify({prNumber, truncated, diff})` result must fit under, not
 * just the raw diff text. A flat `MAX_DIFF_CHARS = 20_000` on the raw diff
 * (this constant's own previous shape) missed exactly that distinction:
 * `JSON.stringify` turns every real newline in the diff into the two
 * characters `\n`, and a unified diff is mostly newlines, so a diff already
 * at the raw 20,000-character cap serialized to well over router.ts's own
 * ceiling on `content` — `ai.chat.send` then 500'd on its own OUTPUT
 * validation (`String must contain at most 20000 character(s)`), found from
 * a real report ("tell me the diff for pr 135" — "The assistant could not
 * reply") rather than any test in this file, since none of them assert the
 * SERIALIZED size of a large diff. Kept a little below 20,000, not equal to
 * it, as a safety margin for the `{"prNumber":...,"truncated":...,
 * "diff":"..."}` wrapper's own overhead and for the truncation notice
 * `fitDiffToBudget` appends to a cut diff.
 */
const MAX_TOOL_RESULT_CONTENT_CHARS = 19_500;
const MAX_COMMENTS = 30;
const MAX_FILES = 50;
/** GitHub's `/pulls/{n}/files` endpoint has no "find this one filename"
    query — the only way to get one file's own `patch` is to page through
    the same listing `getPullRequestFiles` uses and scan for a match.
    `per_page=100` (GitHub's own max) keeps this to one request for the
    overwhelming majority of PRs; capped at 5 pages (500 files) as real
    input-size hygiene against a pathological PR, the same role `MAX_FILES`
    plays for the plain listing — a PR that large has bigger problems than
    this lookup being unable to find one file in it. */
const MAX_FILE_DIFF_LOOKUP_PAGES = 5;
/* One page is enough for a rollup — a status DOT needs "did anything fail,
   is anything still running," never the full per-check breakdown a person
   would get by opening the PR on GitHub. */
const MAX_CHECK_RUNS = 100;
/** GitHub's own closed set of `conclusion` values that count as a real
    failure for a pass/fail dot — `'neutral'` and `'skipped'` are
    deliberately excluded, matching GitHub's own PR merge-check behavior of
    not blocking on either. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

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

export interface PrStatus {
  readonly number: number;
  /** GitHub's own two values for a pull request — `merged` is a THIRD,
      orthogonal fact layered on top of `closed` (a merged PR is always
      `state: 'closed'`, but a closed PR is not always merged), never
      folded into a wider enum: the card chips this feeds need to color
      "merged" distinctly from "closed without merging." */
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly isDraft: boolean;
  /** Rolled up server-side from the Checks API's real per-check-run
      `status`/`conclusion` pairs — `'none'` means the head commit carries
      no check runs at all (a repo with no CI configured, or one that has
      not reported yet), never conflated with `'pending'` (checks exist and
      at least one has not completed). Classification stays deterministic,
      the same "compute it once, server-side" instinct this codebase
      applies everywhere a raw status could otherwise be guessed at by a
      caller (`standup.service.ts`'s bucketing, `card_move`'s rank
      derivation). */
  readonly checksStatus: 'success' | 'failure' | 'pending' | 'none';
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
  /* 401 means the token itself is dead — revoked, or the OAuth App's own
     secret rotated — never something a retry recovers from, unlike 403
     (a live token that merely lost scope, or transient rate limiting). 406
     is neither: it means GitHub refused to render the requested MEDIA TYPE
     for this specific resource — found from a real report, `get_pr_diff`
     answering "GitHub answered 406" on a real PR. GitHub's diff/patch media
     types (`application/vnd.github.v3.diff`, and the raw content media type
     `get_pr_file_content` requests) both refuse this way when the target is
     too large to render in that format, or — for a file — when it is
     binary. Naming the real alternative matters here specifically because,
     unlike 401/403, no reconnect or permission change fixes it: the same
     request will keep failing until a smaller-shaped one is asked instead. */
  const hint =
    status === 401
      ? ' — the connector token is invalid or was revoked; reconnect the repository ' +
        '(Settings → Automation)'
      : status === 403
        ? ' — the connector token no longer has access, or GitHub is rate limiting'
        : status === 406
          ? ' — GitHub could not render this in the requested format, most likely because it is ' +
            'too large or binary; try get_pr_files for the file list, or view it directly on GitHub'
          : '';
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

function diffTruncationNote(shown: number, total: number): string {
  return `\n\n… [diff truncated at ${String(shown)} characters; ${String(total - shown)} more characters omitted]`;
}

export interface PrDiffResult {
  readonly prNumber: number;
  readonly truncated: boolean;
  readonly diff: string;
}

/**
 * Slices `raw` down until `JSON.stringify({prNumber, truncated, diff})` —
 * the exact string `execute()` hands back as `ToolResult.content` — fits
 * under `MAX_TOOL_RESULT_CONTENT_CHARS`. Binary search rather than a fixed
 * divisor: JSON's escape expansion is content-dependent (a quote-and-
 * backslash-heavy diff — JSON, a regex, a Windows path — escapes far more
 * per character than a plain-prose one), so no single constant ratio is
 * safe for every diff; searching the actual serialized size is what makes
 * this correct regardless of what the diff contains. `size(mid)` is
 * monotonically non-decreasing in `mid` (each additional raw character can
 * only add characters to the JSON-encoded output, never remove any), which
 * is what makes the search valid.
 */
function fitDiffToBudget(prNumber: number, raw: string): PrDiffResult {
  const whole: PrDiffResult = { prNumber, truncated: false, diff: raw };
  if (JSON.stringify(whole).length <= MAX_TOOL_RESULT_CONTENT_CHARS) return whole;

  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const candidate = raw.slice(0, mid) + diffTruncationNote(mid, raw.length);
    const size = JSON.stringify({ prNumber, truncated: true, diff: candidate }).length;
    if (size <= MAX_TOOL_RESULT_CONTENT_CHARS) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return { prNumber, truncated: true, diff: raw.slice(0, lo) + diffTruncationNote(lo, raw.length) };
}

export async function getPullRequestDiff(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<PrDiffResult> {
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
  return fitDiffToBudget(input.prNumber, raw);
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
 * routinely needs truncating (see `fitDiffToBudget`) before a person ever
 * learns the SHAPE of the change, where the files list is one page
 * regardless of PR size.
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

export interface PrFileDiffResult {
  readonly prNumber: number;
  readonly path: string;
  readonly truncated: boolean;
  readonly patch: string;
}

function filePatchTruncationNote(shown: number, total: number): string {
  return `\n\n… [diff truncated at ${String(shown)} characters; ${String(total - shown)} more characters omitted — open the file on GitHub to see the rest]`;
}

/**
 * `fitDiffToBudget`'s own binary-search shape, repeated rather than factored
 * into one shared generic — the third near-duplicate of that pattern in this
 * file (alongside `fitFileContentToBudget`), matching `githubReadError`'s own
 * precedent of writing each case out rather than building an abstraction none
 * of the others would meaningfully simplify. A single file's own patch is
 * rarely anywhere near this budget — the whole reason this tool exists is
 * that ONE file's diff is normally far smaller than the whole PR's — but a
 * single file can still be enormous, so the same defensive truncation
 * applies rather than trusting that in every case.
 */
function fitFilePatchToBudget(prNumber: number, path: string, raw: string): PrFileDiffResult {
  const whole: PrFileDiffResult = { prNumber, path, truncated: false, patch: raw };
  if (JSON.stringify(whole).length <= MAX_TOOL_RESULT_CONTENT_CHARS) return whole;

  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const candidate = raw.slice(0, mid) + filePatchTruncationNote(mid, raw.length);
    const size = JSON.stringify({ prNumber, path, truncated: true, patch: candidate }).length;
    if (size <= MAX_TOOL_RESULT_CONTENT_CHARS) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return {
    prNumber,
    path,
    truncated: true,
    patch: raw.slice(0, lo) + filePatchTruncationNote(lo, raw.length),
  };
}

/**
 * One file's own line-by-line diff, within a PR — the gap prompted directly:
 * a large PR's whole diff (`get_pr_diff`) routinely has to truncate before
 * showing every file, but `get_pr_files` already tells you the exact SHAPE
 * (which files, how many lines each) with no truncation risk at all, so
 * "show me the change to just this one file" has a real, always-answerable
 * shape this tool exists to serve.
 *
 * GitHub's `/pulls/{n}/files` response — the same endpoint
 * `getPullRequestFiles` already calls — carries a per-file `patch` field
 * (the unified-diff hunks for JUST that file, no `diff --git`/`---`/`+++`
 * header the way `get_pr_diff`'s whole-PR diff has one per file) that the
 * plain file LIST never surfaces. There is no "give me file X's patch"
 * query GitHub accepts directly, so this pages through the same listing and
 * scans for a match — bounded by `MAX_FILE_DIFF_LOOKUP_PAGES`, the real
 * input-size-hygiene role `MAX_FILES` plays for the plain listing.
 *
 * A path that does not match any file this PR actually changed is refused
 * by NAME, pointing at `get_pr_files` for the real list — not a bare
 * "Not found." the way an invented id elsewhere in this registry once was,
 * per this codebase's own documented fix for that exact failure mode
 * (`registry.ts`'s thrown-error prefix).
 *
 * GitHub itself omits `patch` for a file it judges too large to diff, or
 * binary, or a pure rename with no content change — reported back as a
 * plain-English explanation in `patch` rather than an empty string or a
 * thrown error, since the file DID match; there is simply nothing to show,
 * and `get_pr_file_content` is named as the working alternative for seeing
 * the file's own text.
 */
export async function getPullRequestFileDiff(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: {
    readonly prNumber: number;
    readonly path: string;
    readonly repoScope?: string | undefined;
  },
): Promise<PrFileDiffResult> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);
  const headers = githubHeaders(connector.token);

  let match: Record<string, unknown> | undefined;
  for (let page = 1; page <= MAX_FILE_DIFF_LOOKUP_PAGES; page += 1) {
    const response = await fetchFn(
      `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}/files?per_page=100&page=${String(page)}`,
      { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) throw githubReadError(response.status);
    const body = (await response.json()) as unknown[];
    if (body.length === 0) break;
    match = body.filter(isRecord).find((file) => file['filename'] === input.path);
    if (match !== undefined || body.length < 100) break;
  }

  if (match === undefined) {
    throw errors.notFound(
      `"${input.path}" is not one of the files this pull request changed. ` +
        'Use get_pr_files for the exact list of paths.',
    );
  }

  const patch = match['patch'];
  if (typeof patch !== 'string') {
    return {
      prNumber: input.prNumber,
      path: input.path,
      truncated: false,
      patch:
        'GitHub did not provide a line-by-line diff for this file — it is likely binary, too ' +
        'large to diff that way, or unchanged in content (e.g. a pure rename). Use ' +
        'get_pr_file_content to see its current text instead.',
    };
  }

  return fitFilePatchToBudget(input.prNumber, input.path, patch);
}

function rollupChecksStatus(raw: unknown): PrStatus['checksStatus'] {
  if (!isRecord(raw) || !Array.isArray(raw['check_runs'])) return 'none';
  const runs = raw['check_runs'].filter(isRecord);
  if (runs.length === 0) return 'none';
  if (runs.some((run) => run['status'] !== 'completed')) return 'pending';
  if (runs.some((run) => FAILING_CONCLUSIONS.has(String(run['conclusion'])))) return 'failure';
  return 'success';
}

/**
 * State, merged-ness, draft-ness and a rolled-up CI status — what a card's
 * PR chip needs to color itself, in one combined call rather than a
 * per-fact route each: `merged` rides `state: 'closed'` as a THIRD fact
 * (see `PrStatus`'s own doc comment), and the checks rollup needs the head
 * commit sha this same `GET .../pulls/{number}` call already returns, so a
 * second round trip for check runs is unavoidable but a THIRD (to learn the
 * sha) is not.
 */
export async function getPullRequestStatus(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: { readonly prNumber: number; readonly repoScope?: string | undefined },
): Promise<PrStatus> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);

  const prResponse = await fetchFn(
    `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}`,
    {
      headers: githubHeaders(connector.token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!prResponse.ok) throw githubReadError(prResponse.status);
  const prBody: unknown = await prResponse.json();
  if (!isRecord(prBody))
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');

  const state = prBody['state'];
  const head = prBody['head'];
  if (
    (state !== 'open' && state !== 'closed') ||
    !isRecord(head) ||
    typeof head['sha'] !== 'string'
  ) {
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');
  }

  const checksResponse = await fetchFn(
    `https://api.github.com/repos/${repo}/commits/${head['sha']}/check-runs?per_page=${String(MAX_CHECK_RUNS)}`,
    { headers: githubHeaders(connector.token), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  /* Best-effort, not fatal — the PR's own state/merged/draft facts are
     already in hand, and a repo with no Checks API access (an older
     integration scope, or GitHub itself degraded) should still show a
     colored PR chip with no CI dot rather than fail the whole call. */
  const checksStatus = checksResponse.ok ? rollupChecksStatus(await checksResponse.json()) : 'none';

  return {
    number: input.prNumber,
    state,
    merged: prBody['merged_at'] !== null && prBody['merged_at'] !== undefined,
    isDraft: prBody['draft'] === true,
    checksStatus,
  };
}

export interface PrFileContentResult {
  readonly prNumber: number;
  readonly path: string;
  readonly truncated: boolean;
  readonly content: string;
}

function fileContentTruncationNote(shown: number, total: number): string {
  return `\n\n… [file truncated at ${String(shown)} characters; ${String(total - shown)} more characters omitted — open it on GitHub to see the rest]`;
}

/**
 * `fitDiffToBudget`'s own binary-search shape, repeated here rather than
 * factored into one shared generic — a second near-duplicate matches this
 * file's own precedent (`githubReadError`'s 401/403/406 hints, each written
 * out per status rather than a shared table) more closely than inventing an
 * abstraction neither of these two truncators would meaningfully simplify.
 * The property is identical either way: `JSON.stringify({..., content})` —
 * the exact string `execute()` hands back as `ToolResult.content` — must fit
 * under `MAX_TOOL_RESULT_CONTENT_CHARS`, not just `content.length` on its
 * own, for the same JSON-escape-inflation reason `fitDiffToBudget`'s own
 * header documents (a source file is not as newline-dense as a diff, but a
 * minified file or one full of string literals can still escape far enough
 * to matter).
 */
function fitFileContentToBudget(prNumber: number, path: string, raw: string): PrFileContentResult {
  const whole: PrFileContentResult = { prNumber, path, truncated: false, content: raw };
  if (JSON.stringify(whole).length <= MAX_TOOL_RESULT_CONTENT_CHARS) return whole;

  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const candidate = raw.slice(0, mid) + fileContentTruncationNote(mid, raw.length);
    const size = JSON.stringify({ prNumber, path, truncated: true, content: candidate }).length;
    if (size <= MAX_TOOL_RESULT_CONTENT_CHARS) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return {
    prNumber,
    path,
    truncated: true,
    content: raw.slice(0, lo) + fileContentTruncationNote(lo, raw.length),
  };
}

/**
 * A file's own content, at the PR's HEAD commit — the gap a real transcript
 * found: `get_pr_diff`/`get_pr_files` can say WHAT changed, but nothing in
 * this registry could ever show the file's actual current text, so "show me
 * apps/api/src/ai/complete.ts" had no tool to reach for and the model
 * fabricated an answer instead ("this file wasn't part of the repository
 * before this PR") from data it never actually had — `get_pr_diff` had
 * failed with a 406 the very same turn, so nothing about the file's history
 * was known at all.
 *
 * Needs the PR's head SHA first (an extra round trip `getPullRequestStatus`
 * already pays for the identical reason — the checks call needs it too),
 * because "the file at this PR" means the file on the PR's own branch, not
 * whatever the default branch happens to hold right now.
 *
 * `application/vnd.github.raw` — not the default `application/vnd.github+json`
 * — is what makes GitHub's Contents API return the file's actual bytes as
 * the response body rather than a JSON envelope with the content base64
 * -encoded inside it; the same "ask GitHub for the shape we actually want,
 * rather than post-processing its default shape" choice `getPullRequestDiff`
 * already makes for `application/vnd.github.v3.diff`. A binary file (an
 * image, a compiled asset) answers 406 under this media type — surfaced by
 * `githubReadError`'s own 406 hint, not silently decoded into garbage text.
 */
export async function getPullRequestFileContent(
  actor: AutomationActor,
  deps: PrReadDeps,
  input: {
    readonly prNumber: number;
    readonly path: string;
    readonly repoScope?: string | undefined;
  },
): Promise<PrFileContentResult> {
  assertMayView(actor);
  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);

  const prResponse = await fetchFn(
    `https://api.github.com/repos/${repo}/pulls/${String(input.prNumber)}`,
    { headers: githubHeaders(connector.token), signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!prResponse.ok) throw githubReadError(prResponse.status);
  const prBody: unknown = await prResponse.json();
  if (!isRecord(prBody))
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');
  const head = prBody['head'];
  if (!isRecord(head) || typeof head['sha'] !== 'string') {
    throw errors.serviceUnavailable('GitHub returned an unrecognized PR shape.');
  }

  /* Each path segment percent-encoded on its own, `/` separators preserved —
     a path containing `@`, `#`, or a literal `..` segment is neutralized the
     same way `encodeURIComponent` already neutralizes it anywhere else in
     this codebase's URL-building; there is no filesystem underneath this
     call for a `..` to traverse, only a GitHub API path, so no `repoPath`
     -style dedicated guard is needed on top of the encoding itself. */
  const encodedPath = input.path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const contentResponse = await fetchFn(
    `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(head['sha'])}`,
    {
      headers: { ...githubHeaders(connector.token), accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!contentResponse.ok) throw githubReadError(contentResponse.status);

  const raw = await contentResponse.text();
  return fitFileContentToBudget(input.prNumber, input.path, raw);
}
