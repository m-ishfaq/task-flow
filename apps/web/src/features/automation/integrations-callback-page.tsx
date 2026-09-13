import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { ErrorView } from '../../components/error-view.js';
import { Input } from '../../components/primitives.js';
import { SecretReveal } from '../../components/secret-reveal.js';
import { useStepUp } from '../auth/use-step-up.js';
import type { Wire } from '@taskflow/client';

/**
 * Where every connector OAuth redirect lands (ai/phase-10-automation.md §7,
 * Wave 4 slice 2).
 *
 * `server.ts`'s `buildIntegrationDeps` registers `${WEB_ORIGIN}/integrations/
 * callback/$provider` with each provider's console — a published contract,
 * deliberately a DIFFERENT path from `/oauth/callback/$provider`: the two
 * flows mint different state claims and must never be able to cross-complete.
 *
 * The round trip loses the in-memory access token, so `complete` is a public
 * route — the org and user the connector row is written under come from the
 * signed state token, never from a session. What still needs a session is
 * `selectRepo` (org-scoped + step-up): the GitHub connect completes at the
 * repo choice, and by the time a human picks one the app shell's boot-time
 * `restore()` has exchanged the httpOnly cookie the round trip never touched
 * — the same recovery the login OAuth callback's `linked` path relies on.
 *
 * ## The verify secret, and the refresh case
 *
 * The GitHub verify secret rides the `complete` response EXACTLY ONCE. It is
 * kept in component state only — never sessionStorage — so a page refresh
 * after the picker rendered loses it, honestly: a lost secret means
 * reconnecting (which mints a fresh one), the webhook precedent. What
 * sessionStorage DOES keep is the integrationId, so a refresh can rebuild the
 * picker through `repos` — the one-time `code` is already burned, and
 * `complete` cannot run again.
 */
type PendingRepo = Wire<
  Extract<
    Awaited<ReturnType<typeof api.automation.integration.complete.mutate>>,
    { status: 'pending_repo' }
  >
>;

const PENDING_STORAGE_KEY = 'taskflow.integration.pending';

/** Above this many repositories the picker gets a filter box; at or below it, scrolling is fine. */
const REPO_FILTER_THRESHOLD = 8;

interface PendingRecord {
  readonly provider: 'github';
  readonly integrationId: string;
}

export function IntegrationsCallbackPage() {
  const { provider } = useParams({ from: '/integrations/callback/$provider' });
  const search = useSearch({ from: '/integrations/callback/$provider' });
  const navigate = useNavigate();
  const sessionStatus = useSession((state) => state.status);

  const [pending, setPending] = useState<PendingRepo | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>(null);
  const [repoFilter, setRepoFilter] = useState('');

  const { guard, dialog } = useStepUp();
  const started = useRef(false);

  const linkErrorMessage =
    search.error !== undefined
      ? `${provider} did not complete: ${search.error}`
      : search.code === undefined || search.state === undefined
        ? 'This connect link is incomplete.'
        : null;

  const backToIntegrations = (
    <Link
      to="/automations"
      search={{ tab: 'integrations' }}
      className="text-sm text-accent underline"
    >
      Back to Integrations
    </Link>
  );

  useEffect(() => {
    /* StrictMode double-invokes effects in development; the authorization
       `code` is single-use, so the second attempt must not fire at all. */
    if (linkErrorMessage !== null || started.current) return;
    started.current = true;

    const code = search.code;
    const state = search.state;
    if (code === undefined || state === undefined) return;

    void (async () => {
      try {
        const result = await api.automation.integration.complete.mutate({ provider, code, state });

        if (result.status === 'connected') {
          await navigate({ to: '/automations', search: { tab: 'integrations' } });
          return;
        }

        /* pending_repo — GitHub. The row exists with the credential stored
           and status 'disconnected'; the connect finishes when a repository
           is chosen below. The integrationId survives a refresh; the verify
           secret does not (see the file header). */
        setPending(result);
        try {
          window.sessionStorage.setItem(
            PENDING_STORAGE_KEY,
            JSON.stringify({
              provider: 'github',
              integrationId: result.integrationId,
            } satisfies PendingRecord),
          );
        } catch {
          /* Storage unavailable: the picker still works for this visit; only
             the refresh-recovery path is lost. */
        }
      } catch (caught) {
        /* `complete` failed. If the code was already burned (the page was
           refreshed after a successful exchange) but a pending record
           survived, rebuild the picker from the stored token instead of
           making the person reconnect from scratch. */
        /* `record.provider` is the literal 'github' by type — `readPendingRecord`
           validated the stored value before casting, so there is nothing left
           to check at the use site. */
        const record = readPendingRecord();
        if (record !== null) {
          try {
            const repos = await api.automation.integration.repos.query({
              integrationId: record.integrationId,
            });
            setPending({
              status: 'pending_repo',
              provider: 'github',
              integrationId: record.integrationId,
              login: '',
              repos,
              webhookUrl: null,
              verifySecret: '',
            });
            setRecovered(true);
            return;
          } catch {
            /* Fall through to the error view — a stale record (e.g. the row
               was connected from another tab) is an error, not a picker. */
          }
        }
        setMutationError(caught);
      }
    })();
  }, [provider, search, linkErrorMessage, navigate]);

  const selectRepo = useMutation({
    mutationFn: (fullName: string) =>
      api.automation.integration.selectRepo.mutate({
        integrationId: pending?.integrationId ?? '',
        fullName,
      }),
    onSuccess: async () => {
      window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
      await navigate({ to: '/automations', search: { tab: 'integrations' } });
    },
    onError: (error: unknown) => {
      if (
        guard(error, () => {
          selectRepo.mutate(lastPicked.current);
        })
      ) {
        return;
      }
      setMutationError(error);
    },
  });

  const lastPicked = useRef('');
  const pick = (fullName: string) => {
    lastPicked.current = fullName;
    selectRepo.mutate(fullName);
  };

  if (linkErrorMessage !== null || (mutationError !== null && pending === null)) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink">Connect did not complete</h1>
        {linkErrorMessage !== null ? (
          <p className="text-sm text-danger">{linkErrorMessage}</p>
        ) : (
          <ErrorView error={mutationError} />
        )}
        {backToIntegrations}
      </div>
    );
  }

  if (pending === null) {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-ink-muted">Completing the connection…</p>
      </div>
    );
  }

  /* GitHub — the repo picker. `selectRepo` is org-scoped and step-up, so it
     needs a session: wait out the app shell's boot-time restore rather than
     firing an authenticated call against a session that has not settled. */
  if (sessionStatus === 'restoring') {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-ink-muted">Resuming your session…</p>
      </div>
    );
  }

  if (sessionStatus === 'anonymous') {
    return (
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink">Your session is gone</h1>
        <p className="text-sm text-ink-muted">
          The round trip to {provider} lost your sign-in. Sign back in and reconnect — the
          connection was not saved.
        </p>
        <Link to="/login" className="text-sm text-accent underline">
          Sign in
        </Link>
      </div>
    );
  }

  /* Matched on `full_name`, so typing either half of `owner/name` narrows —
     the two things a person actually remembers about a repository. Plain
     `includes` on the lowercased value rather than a fuzzy match: this list
     is the authorization surface for the org's outbound identity, and a
     picker that reorders results by a relevance score it invented is one
     where the wrong repo is one careless click away. */
  const filterTerm = repoFilter.trim().toLowerCase();
  const visibleRepos =
    filterTerm === ''
      ? pending.repos
      : pending.repos.filter((repo) => repo.fullName.toLowerCase().includes(filterTerm));

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Choose the repository</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          The connection is authorized for {pending.login || 'your GitHub account'}. It becomes a
          connector for the repository you pick — events from that repo will be verifiable, and
          automation actions will act as it.
        </p>
      </div>

      {/* The one-time moment: URL + secret, pasted together into the repo's
          webhook config. Recovered-after-refresh renders without the secret
          and says so. */}
      {recovered ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-ink">
          This page was refreshed, so the verification secret is gone. It was shown once at connect
          time; reconnect to mint a new one.
        </div>
      ) : pending.verifySecret !== '' ? (
        <SecretReveal
          name={`${provider} webhook (${pending.integrationId.slice(0, 8)})`}
          secret={pending.verifySecret}
          onDismiss={() => {
            /* The secret is deliberately NOT kept after dismissal — it cannot
               be re-shown, and pretending otherwise would let it leak later. */
            setPending({ ...pending, verifySecret: '' });
          }}
        />
      ) : null}

      {pending.repos.length === 0 ? (
        <p className="text-sm text-ink-muted">
          This connection can reach no repositories. Authorize access to a repository in GitHub and
          reconnect.
        </p>
      ) : (
        <div className="space-y-2">
          {/* The filter appears only once the list is long enough to need it.
              A GitHub account can reach hundreds of repositories (the service
              walks up to ten pages of 100), and scrolling to find one in a
              72-unit-tall box is the difference between this picker working
              and the person giving up mid-connect. Below the threshold a
              search box is noise on a screen whose one job is a single
              choice. */}
          {pending.repos.length > REPO_FILTER_THRESHOLD && (
            <Input
              type="search"
              value={repoFilter}
              placeholder={`Filter ${String(pending.repos.length)} repositories…`}
              aria-label="Filter repositories"
              onChange={(event) => {
                setRepoFilter(event.target.value);
              }}
            />
          )}

          {visibleRepos.length === 0 ? (
            /* A filter that matches nothing must say so. Rendering an empty
               list instead reads as "this connection can reach no
               repositories" — the message directly above — and sends someone
               off to re-authorize GitHub over a typo. */
            <p className="px-1 py-2 text-sm text-ink-muted">
              No repository matches “{repoFilter}”.
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {visibleRepos.map((repo) => (
                <li key={repo.fullName}>
                  <button
                    type="button"
                    disabled={selectRepo.isPending}
                    onClick={() => {
                      pick(repo.fullName);
                    }}
                    className="w-full rounded-md border border-line bg-surface px-3 py-2 text-left text-sm text-ink transition-colors duration-(--motion-fast) hover:border-accent hover:bg-surface-hover disabled:opacity-60"
                  >
                    {repo.fullName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selectRepo.isError && <ErrorView error={selectRepo.error} />}
      {backToIntegrations}
      {dialog}
    </div>
  );
}

function readPendingRecord(): PendingRecord | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['provider'] === 'github' &&
      typeof (parsed as Record<string, unknown>)['integrationId'] === 'string'
    ) {
      return parsed as PendingRecord;
    }
    return null;
  } catch {
    return null;
  }
}
