import { errors } from '@taskflow/contracts';
import { can } from '@taskflow/policy';
import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import type { CardId } from '@taskflow/contracts';
import { loadCard } from '../work/card.service.js';
import { linkCardBranch } from '../work/card-branch.service.js';
import { ancestorsOfCard, enforceOn, type WorkActor } from '../work/shared.js';
import { connectedGithubRepo, type IntegrationDeps } from './integration.service.js';
import { repoPath } from './integration-action.service.js';
import { integrationBranchCreated } from './integration-events.js';

/**
 * "Create a branch from this card" (ai/phase-15-ai-copilot-and-permissions.md
 * §7.2's last unbuilt action) — the one item from §7's original four-
 * permission list (`pr:view`, `pr:review`, `pr:merge`, `repo:connect`) that
 * went the longest without a caller. `repo:connect` gates it because a
 * branch is a repo-level write, a bigger blast radius than posting a
 * comment or even merging a PR someone else already reviewed — a fresh ref
 * on the default branch, visible to the whole GitHub org the instant it
 * exists, is not something every `pr:review`/`pr:merge` holder should be
 * able to create without a separate grant.
 *
 * ## The branch name is deterministic, never asked of the model
 *
 * `<reference>-<slug>` — e.g. `web-142-fix-login-redirect` — built entirely
 * from data this service already has (the card's own reference and title),
 * the identical "classification stays deterministic" instinct this
 * codebase applies everywhere a name or a fact could otherwise be guessed
 * (`standup.service.ts`'s bucketing, `card_move`'s rank derivation). A
 * model-composed branch name would drift from what a person typing the
 * same card's reference into their own terminal expects.
 *
 * ## No existence check is skipped — GitHub's own ref lookup decides
 *
 * Unlike `card_link_pr` (which records a claim with no GitHub round trip at
 * all, by design — see that file's own header), THIS action creates a real
 * ref on a real repo, so "does a branch with this name already exist" is a
 * real question with a real, cheap answer: `GET .../git/ref/heads/<name>`
 * before ever attempting `POST .../git/refs`. An existing branch is
 * reported back rather than treated as failure — the caller asked for a
 * branch to exist, and it already does; erroring on that would make a
 * retried confirmation (the same shape `linkCardPullRequest`'s own
 * idempotency exists for) fail for no reason.
 *
 * ## `branchName` is an override, not a second naming scheme
 *
 * The direct card-detail UI (`apps/web/src/features/work/detail/development-
 * section.tsx`) needs "editable, prefilled with the deterministic default" —
 * so a caller MAY pass `branchName`, which is run through the identical
 * `slugify` the default already uses (never trusted as a literal git ref:
 * arbitrary text becomes a real `POST .../git/refs` body) and used verbatim
 * in place of the computed default. An override that slugifies to an empty
 * string (someone clears the field entirely) falls back to the deterministic
 * name rather than attempting to create a branch called `""`.
 *
 * ## The card→branch fact is recorded here, not by each caller separately
 *
 * `linkCardBranch` (`work/card-branch.service.ts`) is called from BOTH
 * outcomes below — a freshly created ref and one that already existed —
 * because either way the branch now IS this card's, and a caller (this
 * service's own tRPC route, or the AI tool) should not have to remember to
 * record that fact itself. Only the newly-created path also emits
 * `integration.branch_created`; recording that GitHub event for a branch
 * that already existed before this call would be a false "created" claim in
 * a hash-chained log, the same discipline this file's own header already
 * states for the create-vs-exists split itself. `card:update` is checked as
 * part of loading the card, UP FRONT — before any GitHub call — so a caller
 * who holds `repo:connect` but cannot edit THIS card is refused before a
 * branch is created that nothing would ever record as belonging to it.
 */

/* 'providers' (migration 0109) — see `PrWriteDeps`'s identical comment in
   pr-write.service.ts. */
export type BranchWriteDeps = Pick<IntegrationDeps, 'keys' | 'fetchImpl' | 'providers'>;

const TIMEOUT_MS = 10_000;
/* GitHub refuses a ref name over 250 bytes outright; well short of that is
   plenty to keep a branch name legible in a terminal prompt or a CI job
   name, the same "don't let one absurdly long title win" reasoning
   `apps/mobile/src/lib/org-picker.ts`'s own `slugify` caps a slug at 40. */
const MAX_SLUG_LENGTH = 50;

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

/** Lowercase, hyphens for anything that is not `[a-z0-9]`, trimmed and
    collapsed — the identical shape `apps/mobile/src/lib/org-picker.ts`'s
    own `slugify` already uses for the same "make arbitrary human text safe
    as an identifier" problem, duplicated locally rather than imported
    across an app boundary this codebase does not otherwise cross. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

/* 401 means the token itself is dead — revoked, or the OAuth App's own
   secret rotated — never something a retry recovers from, unlike 403 (a
   live token that merely lost write access, or transient rate limiting).
   The same distinction pr-read.service.ts's own `githubReadError` and
   pr-write.service.ts's `githubWriteError` already draw. */
function githubErrorHint(status: number): string {
  if (status === 401) {
    return (
      ' — the connector token is invalid or was revoked; reconnect the repository ' +
      '(Settings → Automation)'
    );
  }
  if (status === 403) {
    return ' — the connector token no longer has write access, or GitHub is rate limiting';
  }
  return '';
}

function assertMayConnect(actor: WorkActor): void {
  if (!can(actor.subject, 'repo:connect').allowed) {
    throw errors.forbidden(
      'You do not have permission to create branches from this org’s repository.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface CreatedBranch {
  readonly branchName: string;
  readonly alreadyExisted: boolean;
  readonly url: string;
  readonly providerScope: string;
}

export async function createBranchFromCard(
  actor: WorkActor,
  deps: BranchWriteDeps,
  input: {
    readonly cardId: CardId;
    readonly repoScope?: string | undefined;
    readonly branchName?: string | undefined;
  },
): Promise<CreatedBranch> {
  assertMayConnect(actor);

  const { reference, title } = await withOrgScope(actor.subject.orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    /* `card:update`, not `card:read` — this call is always going to record a
       card->branch link (see this file's own header), so failing here, before
       any GitHub call, is what keeps a permission refusal from leaving an
       orphan branch that nothing would ever record as belonging to this
       card. */
    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    const projects = await tx
      .select({ key: schema.projects.key })
      .from(schema.projects)
      .where(eq(schema.projects.id, card.projectId))
      .limit(1);
    const project = projects[0];
    if (!project) throw errors.notFound();

    return { reference: `${project.key}-${String(card.number)}`, title: card.title };
  });

  const connector = await connectedGithubRepo(actor.subject.orgId, deps, input.repoScope);
  const fetchFn = deps.fetchImpl ?? fetch;
  const repo = repoPath(connector.providerScope);
  const headers = githubHeaders(connector.token);

  const defaultBranchName = `${slugify(reference)}-${slugify(title)}`.replace(/-+$/, '');
  const branchName =
    input.branchName === undefined
      ? defaultBranchName
      : slugify(input.branchName).replace(/-+$/, '') || defaultBranchName;

  const existingRes = await fetchFn(
    `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(branchName)}`,
    { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (existingRes.ok) {
    await linkCardBranch(actor, {
      cardId: input.cardId,
      providerScope: connector.providerScope,
      branchName,
    });
    return {
      branchName,
      alreadyExisted: true,
      url: `https://github.com/${connector.providerScope}/tree/${branchName}`,
      providerScope: connector.providerScope,
    };
  }
  if (existingRes.status !== 404) {
    throw errors.serviceUnavailable(
      `GitHub answered ${String(existingRes.status)}${githubErrorHint(existingRes.status)}.`,
    );
  }

  const repoRes = await fetchFn(`https://api.github.com/repos/${repo}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!repoRes.ok) {
    throw errors.serviceUnavailable(
      `GitHub answered ${String(repoRes.status)}${githubErrorHint(repoRes.status)}.`,
    );
  }
  const repoBody = await repoRes.json();
  const defaultBranch =
    isRecord(repoBody) && typeof repoBody['default_branch'] === 'string'
      ? repoBody['default_branch']
      : null;
  if (defaultBranch === null) {
    throw errors.serviceUnavailable('GitHub did not report a default branch for this repository.');
  }

  const baseRes = await fetchFn(
    `https://api.github.com/repos/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    { headers, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!baseRes.ok) {
    throw errors.serviceUnavailable(
      `GitHub answered ${String(baseRes.status)}${githubErrorHint(baseRes.status)}.`,
    );
  }
  const baseBody = await baseRes.json();
  const baseSha =
    isRecord(baseBody) &&
    isRecord(baseBody['object']) &&
    typeof baseBody['object']['sha'] === 'string'
      ? baseBody['object']['sha']
      : null;
  if (baseSha === null) {
    throw errors.serviceUnavailable('GitHub did not report a commit sha for the default branch.');
  }

  const createRes = await fetchFn(`https://api.github.com/repos/${repo}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!createRes.ok) {
    throw errors.serviceUnavailable(
      `GitHub answered ${String(createRes.status)} creating the branch` +
        `${githubErrorHint(createRes.status)}.`,
    );
  }

  // After the effect, never before — same discipline as pr-write.service.ts.
  await withOrgScope(actor.subject.orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        integrationBranchCreated,
        {
          integrationId: connector.integrationId,
          provider: 'github',
          providerScope: connector.providerScope,
          cardId: input.cardId,
          branchName,
        },
        { orgId: actor.subject.orgId, actorId: actor.subject.userId, requestId: actor.requestId },
      ),
    ]);
  });

  await linkCardBranch(actor, {
    cardId: input.cardId,
    providerScope: connector.providerScope,
    branchName,
  });

  return {
    branchName,
    alreadyExisted: false,
    url: `https://github.com/${connector.providerScope}/tree/${branchName}`,
    providerScope: connector.providerScope,
  };
}
