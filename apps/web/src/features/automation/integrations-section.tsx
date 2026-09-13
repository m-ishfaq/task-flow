import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import type { Wire } from '@taskflow/client';
import { Button, ConfirmButton, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { integrationCapabilitiesQuery, integrationsQuery } from './api.js';

/**
 * The Integrations tab (ai/phase-10-automation.md §7, Wave 4 slice 2).
 *
 * Connects the org's Slack workspace or GitHub repository — the OUTBOUND
 * identity a rule's `slack.post_message` / `github.*` actions will use
 * (slice 4). The connect itself is a full browser round trip through the
 * provider's consent screen: `begin` (step-up — wiring the org's outbound
 * identity is a standing-capability decision, §7.8) returns the provider's
 * authorization URL, and the page navigates away; `/integrations/callback`
 * is where the flow resumes.
 *
 * The UI never re-derives authorization. The section renders and the server
 * answers; a member without `integration:manage` gets an honest FORBIDDEN
 * where the list would be (§8.2).
 */

/** One connector row, as the wire actually delivers it. */
type IntegrationSummary = Wire<
  Awaited<ReturnType<typeof api.automation.integration.list.query>>
>[number];

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  slack: 'Slack',
  github: 'GitHub',
};

export function IntegrationsSection({ orgId }: { readonly orgId: string }) {
  const capabilities = useQuery({
    ...integrationCapabilitiesQuery(orgId),
    enabled: orgId !== '',
  });
  const integrations = useQuery({ ...integrationsQuery(orgId), enabled: orgId !== '' });

  if (capabilities.isPending || integrations.isPending) return <SkeletonRows rows={2} />;
  if (capabilities.isError) return <ErrorText error={capabilities.error} />;
  if (integrations.isError) return <ErrorText error={integrations.error} />;

  const configured = (['slack', 'github'] as const).filter(
    (provider) => capabilities.data[provider],
  );

  return (
    <section className="space-y-4">
      <p className="text-xs text-ink-faint">
        Connect a Slack workspace or GitHub repository so automation rules can act as this
        organization on it. Connecting is a deliberate act: it grants the org's outbound identity,
        so it requires re-authenticating first.
      </p>

      {configured.length === 0 ? (
        <Empty
          title="No connectors configured on this server"
          description="An operator must set the connector client credentials in the deployment environment before anything can be connected here."
        />
      ) : integrations.data.length === 0 ? (
        <Empty
          title="Nothing connected yet"
          description="Connect a Slack workspace or GitHub repository below, then use it from a rule's actions."
        />
      ) : null}

      <div className="space-y-2">
        {configured.map((provider) => (
          <ProviderRow
            key={provider}
            orgId={orgId}
            provider={provider}
            integrations={integrations.data}
            webhookUrl={capabilities.data.webhookOrigin}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({
  orgId,
  provider,
  integrations,
  webhookUrl,
}: {
  readonly orgId: string;
  readonly provider: 'slack' | 'github';
  readonly integrations: readonly IntegrationSummary[];
  readonly webhookUrl: string | null;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const [copying, setCopying] = useState(false);
  /* Which row a disconnect is for, so the step-up retry re-fires the SAME
     one. A single `connected` row was enough when a provider could only hold
     one; with several repos, replaying the wrong id would disconnect a
     connector the person never touched. */
  const lastDisconnected = useRef('');

  /* A GitHub connect writes its row keyed on the ACCOUNT login first, and
     `selectRepo` re-keys it to `owner/name` — so a github scope with no slash
     is a connect that never reached the repo choice (abandoned at the picker,
     or superseded once its credentials moved to the repo's own row). It is
     not a repository and must not be listed as one: showing `m-ishfaq` beside
     `m-ishfaq/task-flow` reads as a connector that exists and does nothing.
     The row still lives in the database as the org's audit trail; this is a
     display decision, not a deletion. */
  const rows = integrations.filter(
    (row) =>
      row.provider === provider && (provider !== 'github' || row.providerScope.includes('/')),
  );
  const live = rows.filter((row) => row.status === 'connected');

  /* GitHub connects one REPOSITORY per row, and an org routinely wants
     several — so the connect action stays available after the first. Slack's
     scope IS the workspace, so a second connect would be a second workspace,
     which this product surface does not model: one connected row hides it.
     The asymmetry is in the data (provider_scope means different things), not
     a UI preference. */
  const canConnectMore = provider === 'github' || live.length === 0;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.integrations(orgId) });

  const begin = useMutation({
    mutationFn: () => api.automation.integration.begin.mutate({ provider }),
    onSuccess: (result) => {
      /* A plain navigation, the oauth.ts precedent: the consent screen lives
         on another origin, and TanStack Router has no part in getting there. */
      window.location.href = result.authorizationUrl;
    },
    onError: (error: unknown) => {
      if (
        guard(error, () => {
          begin.mutate();
        })
      ) {
        return;
      }
      toast.failure(`Could not start the ${PROVIDER_LABEL[provider] ?? provider} connect`, error);
    },
  });

  const disconnect = useMutation({
    mutationFn: (integrationId: string) =>
      api.automation.integration.disconnect.mutate({ integrationId }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      if (
        guard(error, () => {
          disconnect.mutate(lastDisconnected.current);
        })
      ) {
        return;
      }
      toast.failure('The connector could not be disconnected', error);
    },
  });

  const webhookUrlFor = (): string | null =>
    webhookUrl === null ? null : `${webhookUrl}/integrations/${provider}`;

  return (
    <div className="overflow-hidden rounded-lg border border-line/50">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-surface-raised px-3 py-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {PROVIDER_LABEL[provider] ?? provider}
            </span>
            {live.length > 0 && (
              <span className="shrink-0 rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                {provider === 'github' && live.length > 1
                  ? `${String(live.length)} connected`
                  : 'Connected'}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-ink-faint">
            {live.length === 0
              ? 'Not connected'
              : provider === 'github'
                ? 'Automation rules can act on these repositories.'
                : live[0]?.providerScope}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {canConnectMore && (
            <Button
              size="sm"
              className="h-6 px-1.5 text-xs"
              disabled={begin.isPending}
              onClick={() => {
                begin.mutate();
              }}
            >
              {begin.isPending
                ? 'Opening consent…'
                : live.length === 0
                  ? 'Connect'
                  : 'Connect another repo'}
            </Button>
          )}
        </div>
      </div>

      {/* Every scope this provider holds, live and dead. A disconnected row is
          shown rather than filtered out because it is the org's record that
          the scope was once authorized — the same reason the row survives a
          disconnect in the database at all. */}
      {rows.length > 0 && (
        <ul className="divide-y divide-line/40 border-t border-line/50/50">
          {rows.map((row) => (
            <li
              key={row.integrationId}
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex items-center gap-1.5">
                  <a
                    href={`https://github.com/${row.providerScope}`}
                    target="_blank"
                    className={`truncate font-mono text-[12px] ${
                      row.status === 'connected' ? 'text-ink' : 'text-ink-faint line-through'
                    }`}
                    title={row.providerScope}
                  >
                    {row.providerScope}
                  </a>
                  {row.status === 'disconnected' && (
                    <span className="shrink-0 rounded-md bg-surface-raised px-1 py-0.5 text-[10px] text-ink-faint">
                      Disconnected
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-faint">
                  {row.name !== row.providerScope && `${row.name} · `}
                  Connected {new Date(row.createdAt).toLocaleDateString()}
                </p>
              </div>

              {row.status === 'connected' && (
                <ConfirmButton
                  label="Disconnect"
                  confirmLabel={`Disconnect ${row.providerScope}`}
                  disabled={disconnect.isPending}
                  className="h-6 shrink-0 px-1.5 text-xs"
                  onConfirm={() => {
                    lastDisconnected.current = row.integrationId;
                    disconnect.mutate(row.integrationId);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The webhook URL events arrive at. Not a secret (it is derivable from
          the origin), but it is the value someone pastes into a Slack app's
          event subscription or a GitHub repo webhook — shown with a copy
          button rather than buried in the flow. The per-org GitHub VERIFY
          secret is different: that one is shown exactly once, on the connect
          callback page. */}
      {webhookUrl !== null && (
        <div className="flex items-center gap-2 border-t border-line/50 px-3 py-1.5">
          <code
            className="min-w-0 flex-1 truncate font-mono text-xs text-ink-faint"
            title={webhookUrlFor() ?? undefined}
          >
            {webhookUrlFor()}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(webhookUrlFor() ?? '').then(() => {
                setCopying(true);
              });
            }}
            className="shrink-0 text-xs text-ink-faint hover:text-ink"
          >
            {copying ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      )}

      {begin.isError && <ErrorText error={begin.error} />}
      {disconnect.isError && <ErrorText error={disconnect.error} />}
      {dialog}
    </div>
  );
}
