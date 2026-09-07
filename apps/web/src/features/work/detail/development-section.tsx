import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, GitPullRequest, Plus } from 'lucide-react';
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
import { cardBranchesQuery, cardPullRequestsQuery } from '../api.js';
import { integrationsQuery } from '../../automation/api.js';
import { defaultBranchName, normalizedBranchName } from './branch-name.js';

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
 * `card:read`/`card:update` gate the PR half server-side, the same as every
 * sibling section here — no client-side capability check, since neither
 * permission is individually grantable or role-restricted the way
 * `recording:read` is. Creating a branch is different: `repo:connect` IS
 * individually grantable (Phase 15 §1), so the "Create branch" button is
 * gated on `canCreateBranches` (`SettingsCapabilities.createBranches`,
 * computed by the caller) — hidden, not disabled, per that phase's own
 * "hide entirely" rule. Reading the branch list needs no such gate: seeing
 * what already exists is `card:read`, the identical split
 * `readPhoneNumbers` draws against `placeCalls` elsewhere in this app.
 */

export function DevelopmentSection({
  orgId,
  cardId,
  reference,
  title,
  canCreateBranches,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly reference: string;
  readonly title: string;
  readonly canCreateBranches: boolean;
}) {
  return (
    <Section title="Development">
      <div className="space-y-5">
        <PullRequestSubsection orgId={orgId} cardId={cardId} />
        <BranchSubsection
          orgId={orgId}
          cardId={cardId}
          reference={reference}
          title={title}
          canCreate={canCreateBranches}
        />
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Pull requests
 * -------------------------------------------------------------------------- */

function PullRequestSubsection({
  orgId,
  cardId,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const linked = useQuery(cardPullRequestsQuery(orgId, cardId));
  const integrations = useQuery(integrationsQuery(orgId));
  const [prNumber, setPrNumber] = useState('');

  const repo = integrations.data?.find(
    (row) => row.provider === 'github' && row.status === 'connected',
  );

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
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        <GitPullRequest aria-hidden="true" className="size-3.5" strokeWidth={2} />
        Pull requests
      </h3>

      {linked.isPending ? (
        <SkeletonRows rows={1} />
      ) : linked.isError ? (
        <ErrorView error={linked.error} title="Could not load linked pull requests" />
      ) : linked.data.length === 0 ? null : (
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
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                disabled={unlink.isPending}
                onClick={() => {
                  unlink.mutate({ providerScope: pr.providerScope, prNumber: pr.prNumber });
                }}
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && <ErrorText error={unlink.error} />}

      {integrations.isSuccess && repo === undefined ? (
        <p className="text-[11px] text-ink-faint">
          Connect a GitHub repository (Settings → Automation) to link pull requests.
        </p>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Number(prNumber);
            if (repo === undefined || !Number.isInteger(parsed) || parsed <= 0) return;
            link.mutate({ providerScope: repo.providerScope, prNumber: parsed });
          }}
        >
          <Input
            value={prNumber}
            onChange={(event) => {
              setPrNumber(event.target.value);
            }}
            type="number"
            min={1}
            placeholder="PR number"
            className="h-7 w-28 text-xs"
            disabled={repo === undefined}
          />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={link.isPending || prNumber === ''}
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
  canCreate,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly reference: string;
  readonly title: string;
  readonly canCreate: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const linked = useQuery(cardBranchesQuery(orgId, cardId));
  const integrations = useQuery(integrationsQuery(orgId));
  const [formOpen, setFormOpen] = useState(false);
  const [branchNameInput, setBranchNameInput] = useState('');

  const repo = integrations.data?.find(
    (row) => row.provider === 'github' && row.status === 'connected',
  );

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.cardBranches(orgId, cardId) });

  const openForm = () => {
    setBranchNameInput(defaultBranchName(reference, title));
    setFormOpen(true);
  };

  const create = useMutation({
    mutationFn: (branchName: string) =>
      api.work.branches.create.mutate(branchName === '' ? { cardId } : { cardId, branchName }),
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
      <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        <GitBranch aria-hidden="true" className="size-3.5" strokeWidth={2} />
        Branches
      </h3>

      {linked.isPending ? (
        <SkeletonRows rows={1} />
      ) : linked.isError ? (
        <ErrorView error={linked.error} title="Could not load linked branches" />
      ) : linked.data.length === 0 ? null : (
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
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
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
            </li>
          ))}
        </ul>
      )}
      {unlink.isError && <ErrorText error={unlink.error} />}

      {!canCreate ? null : integrations.isSuccess && repo === undefined ? (
        <p className="text-[11px] text-ink-faint">
          Connect a GitHub repository (Settings → Automation) to create branches.
        </p>
      ) : !formOpen ? (
        <Button size="sm" variant="ghost" onClick={openForm} disabled={repo === undefined}>
          <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
          Create branch
        </Button>
      ) : (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(branchNameInput.trim());
          }}
        >
          <FocusOnMountInput
            value={branchNameInput}
            onChange={(event) => {
              setBranchNameInput(event.target.value);
            }}
            placeholder="Branch name"
            className="h-7 font-mono text-xs"
          />
          {preview !== null && (
            <p className="text-[11px] text-ink-faint">
              Will be created as <span className="font-mono text-ink-muted">{preview}</span>
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <Button type="submit" size="sm" variant="ghost" disabled={create.isPending}>
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
