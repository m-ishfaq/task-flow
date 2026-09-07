import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useToast } from '../../../lib/toast-context.js';
import { Button, Input, Section, SkeletonRows } from '../../../components/primitives.js';
import { ErrorText, ErrorView } from '../../../components/error-view.js';
import { cardPullRequestsQuery } from '../api.js';
import { integrationsQuery } from '../../automation/api.js';

/**
 * PRs linked to this card (ai/phase-15-ai-copilot-and-permissions.md §7.2;
 * `work/card-pull-request.service.ts`). The manual counterpart to the
 * assistant's own `list_card_prs`/`card_link_pr` tools — this section is
 * what closes the "shipped backend + AI tool, no consumer for a person who
 * isn't talking to the assistant" gap CLAUDE.md's own account of this
 * codebase's history documents more than once for other features.
 *
 * `card:read`/`card:update` gate this server-side, the same as every
 * sibling section here (`checklist-section.tsx`, `attachment-section.tsx`)
 * — no client-side capability check, since neither permission is
 * individually grantable or role-restricted the way `recording:read` is
 * (which is why `RecordingSection`, alone among these, needs one).
 *
 * The PR number is the only thing this asks for — the repo itself is
 * resolved from the org's own connected GitHub integration
 * (`integrationsQuery`, the same read `integrations-section.tsx`'s settings
 * page already uses), mirroring `card_link_pr`'s own server-side
 * `connectedGithubRepo` resolution so a person never has to type
 * "owner/repo" by hand. With no connected repo, the form explains that
 * instead of failing on submit with a bare server error.
 */

export function PullRequestSection({
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
    <Section title="Pull requests" count={linked.data?.length}>
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
        <p className="mt-2 text-[11px] text-ink-faint">
          Connect a GitHub repository (Settings → Automation) to link pull requests.
        </p>
      ) : (
        <form
          className="mt-2 flex items-center gap-1.5"
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
    </Section>
  );
}
