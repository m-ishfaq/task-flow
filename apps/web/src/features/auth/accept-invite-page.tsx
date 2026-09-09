import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys, resetCache } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import type { OrgId } from '@taskflow/contracts';
import { Button, Spinner } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * The destination of the link in an invitation email (migration 0107).
 *
 * The path is fixed by `apps/api/src/tenancy/invitation-mail.ts` —
 * `/invite/accept?token=` — mail already delivered cannot be corrected, the
 * same reason `verify-email-page.tsx`'s own header gives for its path.
 *
 * Requires a SESSION (`requireSession` in `router.tsx`'s `beforeLoad`),
 * unlike email verification — accepting an invitation is inherently "as
 * someone," and `acceptInvitation` checks that someone against the invited
 * address itself. An unauthenticated visitor is bounced to `/login` with the
 * token preserved in `next`, and lands back here to finish once signed in.
 *
 * Click-to-confirm, not auto-fire on mount — the identical StrictMode/
 * mail-scanner reasoning `verify-email-page.tsx`'s own header documents at
 * length: a double-mounted effect can spend a single-use token with no
 * observer left to hear the result, and a security scanner following the
 * link before a human sees it would burn it silently.
 */
export function AcceptInvitePage() {
  const { token } = useSearch({ from: '/invite/accept' });
  const navigate = useNavigate();
  const selectOrg = useSession((state) => state.selectOrg);
  const queryClient = useQueryClient();

  const accept = useMutation({
    mutationFn: (value: string) => api.tenancy.invitations.accept.mutate({ token: value }),
  });

  const goToOrg = (orgId: string) => {
    selectOrg(orgId as OrgId);
    resetCache(queryClient);
    void queryClient.invalidateQueries({ queryKey: keys.orgs() });
    void navigate({ to: '/projects' });
  };

  if (token === undefined) {
    return (
      <Frame>
        <p className="text-sm text-ink-muted">
          This link is missing its token. Copy the whole URL from the email, including everything
          after the question mark.
        </p>
      </Frame>
    );
  }

  if (accept.isSuccess) {
    const result = accept.data;
    return (
      <Frame>
        <p className="text-sm text-ink">
          {result.alreadyMember
            ? `You're already a member of ${result.orgName}.`
            : `You've joined ${result.orgName} as ${result.role}.`}
        </p>
        <Button
          variant="primary"
          onClick={() => {
            goToOrg(result.orgId);
          }}
        >
          Go to {result.orgName}
        </Button>
      </Frame>
    );
  }

  return (
    <Frame>
      {accept.isError && (
        // A revoked, expired, and never-existed token all get the SAME
        // answer from the server — the identical one-answer-for-every-
        // failure-mode shape verify-email-page.tsx's own note gives, so this
        // cannot be used to probe which of those a given link is. A
        // wrong-address mismatch (FORBIDDEN) is the one case worth saying
        // plainly, since the reader can actually act on it.
        <ErrorView error={accept.error} title="This invitation could not be accepted" />
      )}

      {!accept.isError && (
        <p className="text-sm text-ink-muted">
          Accept this invitation to join the organization it names.
        </p>
      )}

      <Button
        variant="primary"
        disabled={accept.isPending}
        onClick={() => {
          accept.mutate(token);
        }}
      >
        {accept.isPending ? (
          <>
            <Spinner /> Accepting…
          </>
        ) : accept.isError ? (
          'Try again'
        ) : (
          'Accept invitation'
        )}
      </Button>

      {accept.isError && (
        <Link to="/orgs" className="text-sm text-accent underline">
          Go to your organizations
        </Link>
      )}
    </Frame>
  );
}

function Frame({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
      <BrandMark size={36} className="text-accent" />
      <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
        Organization invitation
      </h1>
      {children}
    </div>
  );
}
