import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, GitBranch, GitPullRequest, Plus } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useToast } from '../../../lib/toast-context.js';
import {
  Button,
  FocusOnMountInput,
  Input,
  Section,
  SkeletonRows,
} from '../../../components/primitives.js';
import { ErrorText, ErrorView } from '../../../components/error-view.js';
import { cardBranchesQuery, cardPullRequestsQuery, githubReposQuery } from '../api.js';
import { defaultBranchName, normalizedBranchName } from './branch-name.js';
import { PrStatusBadge } from './pr-status-badge.js';
import { PrDiffButton } from './pr-diff-dialog.js';

/**
 * PRs and branches linked to this card (ai/phase-15-ai-copilot-and-
 * permissions.md §7.2; `work/card-pull-request.service.ts`,
 * `work/card-branch.service.ts`). The manual counterpart to the assistant's
 * own `list_card_prs`/`card_link_pr`/`create_branch_from_card` tools —
 * closes the "shipped backend + AI tool, no consumer for a person who isn't
 * talking to the assistant" gap CLAUDE.md's own account of this codebase's
 * history documents more than once for other features. `card-identity-
 * bar.tsx` (the header row next to the card's reference) renders the SAME
 * two lists as compact, clickable chips; this section is where they are
 * actually managed — linking a PR, creating or unlinking a branch — and
 * where each action's own confirmation/error surface lives.
 *
 * `card:read`/`card:update` gate the PR half server-side; `canEdit`
 * (`cards.get`'s `capabilities.update`) is what hides Link/Unlink on the
 * client to match — a viewer/commenter-relation guest sees the linked PR and
 * branch lists (read data, `card:read`) but never the Link form or an Unlink
 * button, whose submit `card:update` would refuse. Creating a branch is
 * gated SEPARATELY, on `canCreateBranches` (`repo:connect`,
 * `SettingsCapabilities.createBranches`) — individually grantable (Phase 15
 * §1) and a bigger blast radius than linking an already-known PR number, so
 * it is not implied by `canEdit` alone. Reading the branch list needs no
 * such gate: seeing what already exists is `card:read`, the identical split
 * `readPhoneNumbers` draws against `placeCalls` elsewhere in this app.
 *
 * ## The repo picker, and the shared "remembered" choice
 *
 * `githubReposQuery` (`work.githubRepos.list`, `card:read`-gated — see that
 * route's own header for why it replaced `automation.integration.list`,
 * which needed `integration:manage` and refused a plain `card:update`/
 * `repo:connect` holder before they ever reached the permission the action
 * itself needed) is fetched ONCE here and threaded to both subsections. With
 * exactly one connected repo, both forms behave as before — no picker, the
 * one repo is implied. With more than one, each form needs a real choice
 * before it can submit; `selectedRepoScope` is lifted to THIS component so
 * picking a repo in one form (say, linking a PR) is remembered for the
 * other (creating a branch) without asking twice — the same "ask once,
 * reuse for the rest of the session" shape the assistant's own multi-repo
 * handling already uses, just scoped to one open card instead of one
 * conversation.
 */

export function DevelopmentSection({
  orgId,
  cardId,
  reference,
  title,
  canEdit,
  canCreateBranches,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly reference: string;
  readonly title: string;
  readonly canEdit: boolean;
  readonly canCreateBranches: boolean;
}) {
  const repos = useQuery(githubReposQuery(orgId));
  const [selectedRepoScope, setSelectedRepoScope] = useState<string | null>(null);

  /* Read here too, in ADDITION to the identical queries each subsection
     already runs below — React Query dedupes by key, so this costs no extra
     request, only lets the PARENT see the same answer in time to decide
     whether the whole section is worth rendering at all.

     Most cards, in most orgs, have never touched GitHub: no repo connected,
     nothing linked. Rendering "Pull requests" and "Branches" as two bare
     sub-headers with nothing under them — the shape every ordinary card used
     to get — is dead chrome on the single most common card in the app. The
     section now collapses entirely once every query has resolved and there
     is neither content to show nor anything this viewer could do about it;
     while anything is still loading it renders exactly as before, so a slow
     network never flashes the section in and then out. */
  const prLinked = useQuery(cardPullRequestsQuery(orgId, cardId));
  const branchLinked = useQuery(cardBranchesQuery(orgId, cardId));

  const resolved = repos.isSuccess && prLinked.isSuccess && branchLinked.isSuccess;
  const hasRepo = (repos.data?.length ?? 0) > 0;
  const hasAnyLink = (prLinked.data?.length ?? 0) > 0 || (branchLinked.data?.length ?? 0) > 0;
  const canDoAnything = canEdit || canCreateBranches;

  if (resolved && !hasAnyLink && !hasRepo && !canDoAnything) return null;

  /* Both subsections independently offer to "connect a repo" the moment
     their own form has no repo to submit against — right, but repeated
     verbatim underneath each other when BOTH `canEdit` and
     `canCreateBranches` are true, since both conditions trigger from the
     same underlying fact. Shown once here instead; each subsection is told
     to skip its own copy via `suppressConnectHint`. */
  const showConnectHint = resolved && !hasRepo && canDoAnything;

  return (
    <Section title="Development">
      <div className="space-y-5">
        {showConnectHint && (
          <p className="empty-fade text-xs text-ink-faint">
            Connect a GitHub repository (Settings → Automation) to link pull requests or create
            branches.
          </p>
        )}
        <PullRequestSubsection
          orgId={orgId}
          cardId={cardId}
          canEdit={canEdit}
          repos={repos.data ?? []}
          reposLoaded={repos.isSuccess}
          selectedRepoScope={selectedRepoScope}
          onSelectRepoScope={setSelectedRepoScope}
          suppressConnectHint={showConnectHint}
        />
        <BranchSubsection
          orgId={orgId}
          cardId={cardId}
          reference={reference}
          title={title}
          canUnlink={canEdit}
          canCreate={canCreateBranches}
          repos={repos.data ?? []}
          reposLoaded={repos.isSuccess}
          selectedRepoScope={selectedRepoScope}
          onSelectRepoScope={setSelectedRepoScope}
          suppressConnectHint={showConnectHint}
        />
      </div>
    </Section>
  );
}

interface RepoPickerProps {
  readonly repos: readonly { readonly providerScope: string }[];
  readonly value: string | null;
  readonly onChange: (scope: string) => void;
}

/** Shown only when more than one repo is connected — with zero or one, the
    caller already knows which repo to use and never renders this. */
function RepoPicker({ repos, value, onChange }: RepoPickerProps) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-faint">
      Repository
      <select
        aria-label="Repository"
        value={value ?? ''}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
      >
        <option value="" disabled>
          Choose…
        </option>
        {repos.map((repo) => (
          <option key={repo.providerScope} value={repo.providerScope}>
            {repo.providerScope}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The repo a form should act against: the one connected repo when there is
    only one, the shared picker's choice when there is more than one, or
    `undefined` while that choice is still unmade — the caller disables its
    submit control on `undefined` the same way it already does while
    `!reposLoaded`. */
function effectiveRepoScope(
  repos: readonly { readonly providerScope: string }[],
  selected: string | null,
): string | undefined {
  if (repos.length === 1) return repos[0]?.providerScope;
  return selected ?? undefined;
}

/* -------------------------------------------------------------------------- *
 * Pull requests
 * -------------------------------------------------------------------------- */

function PullRequestSubsection({
  orgId,
  cardId,
  canEdit,
  repos,
  reposLoaded,
  selectedRepoScope,
  onSelectRepoScope,
  suppressConnectHint,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly canEdit: boolean;
  readonly repos: readonly { readonly providerScope: string }[];
  readonly reposLoaded: boolean;
  readonly selectedRepoScope: string | null;
  readonly onSelectRepoScope: (scope: string) => void;
  /** The parent already showed one combined "connect a repo" line — see its own header. */
  readonly suppressConnectHint: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const linked = useQuery(cardPullRequestsQuery(orgId, cardId));
  const [prNumber, setPrNumber] = useState('');

  const repoScope = effectiveRepoScope(repos, selectedRepoScope);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.cardPullRequests(orgId, cardId) });

  const link = useMutation({
    mutationFn: (input: { providerScope: string; prNumber: number }) =>
      api.work.pullRequests.link.mutate({ cardId, ...input }),
    onSuccess: async () => {
      setPrNumber('');
      await refresh();
    },
    onError: (error) => {
      toast.failure('The pull request was not linked', error);
    },
  });

  const unlink = useMutation({
    mutationFn: (input: { providerScope: string; prNumber: number }) =>
      api.work.pullRequests.unlink.mutate({ cardId, ...input }),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('The pull request was not unlinked', error);
    },
  });

  return (
    <div className="space-y-2">
      {/* Matches the rest of the panel's small icon-header style
          (checklist-section.tsx, attachment-section.tsx, …) rather than the
          uppercase, letter-spaced treatment this section used to carry on
          its own — the two read as different components on the same page
          otherwise. */}
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <GitPullRequest aria-hidden="true" className="size-3.5" strokeWidth={2} />
        Pull requests
      </h3>

      {linked.isPending ? (
        <SkeletonRows rows={1} />
      ) : linked.isError ? (
        <ErrorView error={linked.error} title="Could not load linked pull requests" />
      ) : linked.data.length === 0 ? (
        !canEdit && <p className="empty-fade text-xs text-ink-faint">No pull requests linked.</p>
      ) : (
        <ul className="space-y-1">
          {linked.data.map((pr) => (
            <li
              key={`${pr.providerScope}#${String(pr.prNumber)}`}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <a
                href={`https://github.com/${pr.providerScope}/pull/${String(pr.prNumber)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-xs text-ink hover:text-accent hover:underline"
              >
                {pr.providerScope}#{pr.prNumber}
              </a>
              <PrStatusBadge
                orgId={orgId}
                providerScope={pr.providerScope}
                prNumber={pr.prNumber}
              />
              <PrDiffButton orgId={orgId} providerScope={pr.providerScope} prNumber={pr.prNumber} />
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                  disabled={unlink.isPending}
                  onClick={() => {
                    unlink.mutate({ providerScope: pr.providerScope, prNumber: pr.prNumber });
                  }}
                >
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && <ErrorText error={unlink.error} />}

      {!canEdit ? null : reposLoaded && repos.length === 0 ? (
        suppressConnectHint ? null : (
          <p className="empty-fade text-xs text-ink-faint">
            Connect a GitHub repository (Settings → Automation) to link pull requests.
          </p>
        )
      ) : (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Number(prNumber);
            if (repoScope === undefined || !Number.isInteger(parsed) || parsed <= 0) return;
            link.mutate({ providerScope: repoScope, prNumber: parsed });
          }}
        >
          {repos.length > 1 && (
            <RepoPicker repos={repos} value={selectedRepoScope} onChange={onSelectRepoScope} />
          )}
          <Input
            value={prNumber}
            onChange={(event) => {
              setPrNumber(event.target.value);
            }}
            type="number"
            min={1}
            placeholder="PR number"
            className="h-7 w-28 text-xs"
            disabled={repoScope === undefined}
          />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={link.isPending || prNumber === '' || repoScope === undefined}
          >
            Link
          </Button>
        </form>
      )}
      {link.isError && <ErrorText error={link.error} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Branches
 * -------------------------------------------------------------------------- */

function BranchSubsection({
  orgId,
  cardId,
  reference,
  title,
  canUnlink,
  canCreate,
  repos,
  reposLoaded,
  selectedRepoScope,
  onSelectRepoScope,
  suppressConnectHint,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly reference: string;
  readonly title: string;
  readonly canUnlink: boolean;
  readonly canCreate: boolean;
  readonly repos: readonly { readonly providerScope: string }[];
  readonly reposLoaded: boolean;
  readonly selectedRepoScope: string | null;
  readonly onSelectRepoScope: (scope: string) => void;
  /** The parent already showed one combined "connect a repo" line — see its own header. */
  readonly suppressConnectHint: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const linked = useQuery(cardBranchesQuery(orgId, cardId));
  const [formOpen, setFormOpen] = useState(false);
  const [branchNameInput, setBranchNameInput] = useState('');

  const repoScope = effectiveRepoScope(repos, selectedRepoScope);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.cardBranches(orgId, cardId) });

  const openForm = () => {
    setBranchNameInput(defaultBranchName(reference, title));
    setFormOpen(true);
  };

  const create = useMutation({
    mutationFn: (input: { branchName: string; repoScope: string }) =>
      api.work.branches.create.mutate(
        input.branchName === ''
          ? { cardId, repoScope: input.repoScope }
          : { cardId, branchName: input.branchName, repoScope: input.repoScope },
      ),
    onSuccess: async (result) => {
      setFormOpen(false);
      setBranchNameInput('');
      await refresh();
      toast.show(
        result.alreadyExisted ? 'Branch already existed — linked to this card' : 'Branch created',
        { tone: 'success', description: result.branchName },
      );
    },
    onError: (error) => {
      toast.failure('The branch was not created', error);
    },
  });

  const unlink = useMutation({
    mutationFn: (input: { providerScope: string; branchName: string }) =>
      api.work.branches.unlink.mutate({ cardId, ...input }),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('The branch was not unlinked', error);
    },
  });

  const preview =
    branchNameInput.trim() === '' ? null : normalizedBranchName(branchNameInput, reference, title);

  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
        <GitBranch aria-hidden="true" className="size-3.5" strokeWidth={2} />
        Branches
      </h3>

      {linked.isPending ? (
        <SkeletonRows rows={1} />
      ) : linked.isError ? (
        <ErrorView error={linked.error} title="Could not load linked branches" />
      ) : linked.data.length === 0 ? (
        !canCreate && <p className="empty-fade text-xs text-ink-faint">No branches linked.</p>
      ) : (
        <ul className="space-y-1">
          {linked.data.map((branch) => (
            <li
              key={`${branch.providerScope}-${branch.branchName}`}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <a
                href={`https://github.com/${branch.providerScope}/tree/${branch.branchName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-xs text-ink hover:text-accent hover:underline"
              >
                {branch.branchName}
              </a>
              <CopyCheckoutButton branchName={branch.branchName} />
              {canUnlink && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-xs"
                  disabled={unlink.isPending}
                  onClick={() => {
                    unlink.mutate({
                      providerScope: branch.providerScope,
                      branchName: branch.branchName,
                    });
                  }}
                >
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && <ErrorText error={unlink.error} />}

      {!canCreate ? null : reposLoaded && repos.length === 0 ? (
        suppressConnectHint ? null : (
          <p className="empty-fade text-xs text-ink-faint">
            Connect a GitHub repository (Settings → Automation) to create branches.
          </p>
        )
      ) : !formOpen ? (
        <Button size="sm" variant="ghost" onClick={openForm} disabled={!reposLoaded}>
          <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
          Create branch
        </Button>
      ) : (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (repoScope === undefined) return;
            create.mutate({ branchName: branchNameInput.trim(), repoScope });
          }}
        >
          {repos.length > 1 && (
            <RepoPicker repos={repos} value={selectedRepoScope} onChange={onSelectRepoScope} />
          )}
          <FocusOnMountInput
            value={branchNameInput}
            onChange={(event) => {
              setBranchNameInput(event.target.value);
            }}
            placeholder="Branch name"
            className="h-7 font-mono text-xs"
          />
          {preview !== null && (
            <p className="text-xs text-ink-faint">
              Will be created as <span className="font-mono text-ink-muted">{preview}</span>
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              disabled={create.isPending || repoScope === undefined}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFormOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {create.isError && <ErrorText error={create.error} />}
    </div>
  );
}

const COPY_FEEDBACK_MS = 1500;

/** Copies the two commands a person actually types to start working on a
    linked branch locally — the same click-to-copy shape
    `card-identity-bar.tsx`'s `CopyableReference` already uses (a
    `Check`/`Copy` icon swap, no toast, no tooltip primitive), reused here
    rather than duplicated with a different feel for the identical
    interaction. `git fetch origin <branch>` first: a branch this session
    just created (or one a teammate pushed) is not necessarily in the local
    clone's remote-tracking refs yet, and `checkout` alone would 404 on it. */
function CopyCheckoutButton({ branchName }: { readonly branchName: string }) {
  const [copied, setCopied] = useState(false);
  const command = `git fetch origin ${branchName} && git checkout ${branchName}`;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      title={command}
      className="h-8 shrink-0 px-2 text-xs"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, COPY_FEEDBACK_MS);
        });
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3 text-success" strokeWidth={2.5} />
      ) : (
        <Copy aria-hidden="true" className="size-3" strokeWidth={2} />
      )}
    </Button>
  );
}
