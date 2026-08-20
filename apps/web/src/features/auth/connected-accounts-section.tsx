import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import {
  AddPanel,
  Button,
  ConfirmButton,
  Empty,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { useStepUp } from './use-step-up.js';
import {
  OAUTH_PROVIDER_LABEL,
  redirectToAuthorization,
  useOAuthProviders,
  type OAuthProvider,
} from './oauth.js';

const ALL_PROVIDERS = ['google', 'github'] as const;

/**
 * Connected OAuth accounts (Phase 12 Wave 2 §3.3) — personal, not org-scoped,
 * the same reasoning `PasskeySection` gives for living under `features/auth`.
 *
 * `startLink` redirects to the provider's consent screen and never returns a
 * result to this component directly — the account either comes back
 * `linked` (`oauth-callback-page.tsx` navigates here on that outcome, which
 * is why this section is expected to re-render fresh) or the whole flow was
 * abandoned, in which case there is nothing to reconcile.
 */
export function ConnectedAccountsSection() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const providers = useOAuthProviders();

  const connected = useQuery({
    queryKey: keys.oauthConnected(),
    queryFn: async () => wire(await api.auth.oauth.listConnected.query()),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.oauthConnected() });

  const startLink = useMutation({
    mutationFn: (provider: OAuthProvider) => api.auth.oauth.startLink.mutate({ provider }),
    onSuccess: (result) => {
      redirectToAuthorization(result.authorizationUrl);
    },
    onError: (error, provider) => {
      guard(error, () => {
        startLink.mutate(provider);
      });
    },
  });

  /**
   * Removal is `stepUp: true` server-side, same reasoning as
   * `PasskeySection`'s `remove` — and the same last-way-in check
   * `deletePasskey` makes, generalized to count this account's OTHER
   * sign-in methods too (`oauth.service.ts`'s `unlink`).
   */
  const unlink = useMutation({
    mutationFn: (provider: OAuthProvider) => api.auth.oauth.unlink.mutate({ provider }),
    onSuccess: refresh,
    onError: (error, provider) => {
      guard(error, () => {
        unlink.mutate(provider);
      });
    },
  });

  const linkedProviders = new Set(connected.data?.map((account) => account.provider) ?? []);
  const availableToLink = ALL_PROVIDERS.filter(
    (provider) => providers.data?.[provider] === true && !linkedProviders.has(provider),
  );

  return (
    <Section
      title="Connected accounts"
      count={connected.data?.length}
      description="Sign in with a linked Google or GitHub account instead of your password."
    >
      {connected.isPending && <SkeletonRows rows={1} className="*:h-12" />}
      {connected.isError && (
        <ErrorView error={connected.error} title="Could not load connected accounts" />
      )}

      {connected.data?.length === 0 && availableToLink.length === 0 && (
        <Empty
          title="No providers available"
          description="This server has no OAuth providers configured."
        />
      )}

      {connected.data !== undefined && connected.data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {connected.data.map((account) => (
            <li
              key={account.provider}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="text-ink">{OAUTH_PROVIDER_LABEL[account.provider]}</p>
                <p className="truncate text-[11px] text-ink-faint">
                  {account.email} · linked {formatDate(account.linkedAt)}
                </p>
              </div>
              <ConfirmButton
                label="Unlink"
                confirmLabel={`Unlink ${OAUTH_PROVIDER_LABEL[account.provider]}`}
                disabled={unlink.isPending}
                onConfirm={() => {
                  unlink.mutate(account.provider);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {availableToLink.length > 0 && (
        <AddPanel>
          <div className="flex flex-wrap gap-2">
            {availableToLink.map((provider) => (
              <Button
                key={provider}
                variant="secondary"
                size="sm"
                disabled={startLink.isPending}
                onClick={() => {
                  startLink.mutate(provider);
                }}
              >
                {startLink.isPending && startLink.variables === provider
                  ? 'Redirecting…'
                  : `Connect ${OAUTH_PROVIDER_LABEL[provider]}`}
              </Button>
            ))}
          </div>
        </AddPanel>
      )}

      {/* A STEP_UP_REQUIRED failure opens the dialog above — see `unlink` and
          `startLink`'s own `onError`. Anything else lands here. */}
      {unlink.isError && <ErrorText error={unlink.error} />}
      {startLink.isError && <ErrorText error={startLink.error} />}

      {dialog}
    </Section>
  );
}
