import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { cn } from '../../lib/cn.js';
import { keys } from '../../lib/query.js';
import { formatRelative, hasPassed } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import type { Wire } from '@taskflow/client';
import { Button, ConfirmButton, Empty, Field, SkeletonRows } from '../../components/primitives.js';
import { SecretReveal } from '../../components/secret-reveal.js';
import { ErrorText } from '../../components/error-view.js';
import { apiTokensQuery, heldApiTokenScopesQuery } from './api.js';

/**
 * The API tokens section (ai/phase-10-automation.md §6.6, Wave 3 slice 5) —
 * the org's programmatic-access credentials, on the same developer surface as
 * webhooks.
 *
 * A token authenticates the whole org's API surface, so its scopes are the
 * form's core: a checkbox list built from the caller's LIVE `can()` (the
 * `heldScopes` route), never a free-text id box. The checklist and the mint
 * route use the same answer, so the form cannot offer a scope the server will
 * refuse — and the default is NOTHING selected, because a credential that
 * starts least-privileged and gets widened on purpose beats one that starts
 * all-powerful and is meant to be narrowed.
 *
 * The token itself is shown exactly once, on create, like the webhook's
 * signing secret — there is no read-back route, and the UI does not pretend
 * there is one.
 */

type TokenSummary = Wire<Awaited<ReturnType<typeof api.apiToken.list.query>>>[number];

export function ApiTokensSection({
  orgId,
  canRevoke,
}: {
  readonly orgId: string;
  /**
   * `apiToken:revoke` — Wave 2 (ai/phase-15-ai-copilot-and-permissions.md
   * §1) split it from `apiToken:create` for individual grants, so a Member
   * granted only `createApiTokens` can mint but never revoke. `TokenRow`
   * hides its Revoke button entirely for that caller rather than rendering
   * it and letting the click land on FORBIDDEN — this was never reachable
   * before the split, since both permissions were Admin/Owner-only by role
   * together until now.
   */
  readonly canRevoke: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<{
    readonly name: string;
    readonly token: string;
  } | null>(null);

  const tokens = useQuery({ ...apiTokensQuery(orgId), enabled: orgId !== '' });

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-faint">
          Long-lived credentials for the org's API — the same surface as webhooks, for scripts and
          integrations. Each token is scoped to a subset of <em>your</em> current permissions, and
          dies the moment you lose your membership.
        </p>
        {!creating && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setCreating(true);
            }}
          >
            New token
          </Button>
        )}
      </div>

      {creating && (
        <TokenCreateForm
          onCreate={(result) => {
            setCreatedToken(result);
            setCreating(false);
          }}
          onCancel={() => {
            setCreating(false);
          }}
        />
      )}

      {/* Shown once, and dismissed by a deliberate click — the same contract
          as the webhook's signing secret. A token that vanished while someone
          was still reading it is a recreated credential. */}
      {createdToken !== null && (
        <SecretReveal
          name={createdToken.name}
          secret={createdToken.token}
          onDismiss={() => {
            setCreatedToken(null);
          }}
        />
      )}

      {tokens.isPending ? (
        <SkeletonRows rows={2} />
      ) : tokens.isError ? (
        <ErrorText error={tokens.error} />
      ) : tokens.data.length === 0 ? (
        <Empty
          title="No API tokens yet"
          description="A script cannot call the API without a credential. Mint one, copy the token into your integration, and it will authenticate as you — narrowed to the scopes you grant it."
          action={
            !creating ? (
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true);
                }}
              >
                New token
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {tokens.data.map((token) => (
            <li key={token.tokenId}>
              <TokenRow orgId={orgId} token={token} canRevoke={canRevoke} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The create form — a name and the scope checklist; the token is minted on submit. */
function TokenCreateForm({
  onCreate,
  onCancel,
}: {
  readonly onCreate: (result: { name: string; token: string }) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const orgId = useSession((state) => state.orgId) ?? '';
  const toast = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<readonly string[]>([]);
  /* Default to a finite lifetime, not forever: a credential should start
     least-privileged in time as well as in scope, and "never expires" is a
     deliberate pick from the list rather than what you get by not choosing.
     0 is the sentinel for that pick — the mutation maps it to `undefined`. */
  const [expiresInDays, setExpiresInDays] = useState(90);

  const held = useQuery({ ...heldApiTokenScopesQuery(orgId), enabled: orgId !== '' });

  /* Grouped by resource so a long catalog reads as sections, not a wall of
     text. The group key is display-only — the value sent is the full
     `<resource>:<action>` string the server validates. */
  const groups = useMemo(() => {
    const byResource = new Map<string, string[]>();
    for (const scope of held.data ?? []) {
      const resource = scope.split(':')[0] ?? scope;
      const list = byResource.get(resource);
      if (list === undefined) byResource.set(resource, [scope]);
      else list.push(scope);
    }
    return [...byResource.entries()];
  }, [held.data]);

  const heldCount = held.data?.length ?? 0;
  const allSelected = heldCount > 0 && selected.length === heldCount;

  const toggle = (scope: string) => {
    setSelected((prev) =>
      prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope],
    );
  };

  const create = useMutation({
    mutationFn: () =>
      api.apiToken.create.mutate({
        name: name.trim(),
        scopes: [...selected],
        // 0 is the "No expiry" option; the route omits the field for forever.
        ...(expiresInDays === 0 ? {} : { expiresInDays }),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.apiTokens(orgId) });
      onCreate({ name: name.trim(), token: result.token });
    },
    onError: (error: unknown) => {
      toast.failure('The token could not be created', error);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
      className="mt-3 space-y-2 rounded-lg border border-line bg-surface-raised p-3"
    >
      <Field label="Name" htmlFor="api-token-name">
        <input
          id="api-token-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={120}
          placeholder="Release CI"
          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </Field>

      <Field
        label="Scopes"
        htmlFor="api-token-scopes"
        hint={
          selected.length === 0
            ? undefined
            : `${String(selected.length)} of ${String(heldCount)} held permission${
                selected.length === 1 ? '' : 's'
              }`
        }
      >
        <div id="api-token-scopes" className="space-y-1">
          {held.isPending ? (
            <SkeletonRows rows={3} />
          ) : held.isError ? (
            <ErrorText error={held.error} />
          ) : groups.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No scopes available — you hold no org permissions.
            </p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-line bg-surface p-2">
              <label className="flex cursor-pointer items-center gap-2 px-1 text-xs font-medium text-ink">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => {
                    setSelected(allSelected ? [] : [...held.data]);
                  }}
                  className="accent-accent"
                />
                {allSelected ? 'Clear all' : 'Select all'}
              </label>
              {groups.map(([resource, scopes]) => (
                <div key={resource}>
                  <p className="px-1 text-xs font-semibold text-ink-muted">{resource}</p>
                  <ul className="space-y-0.5">
                    {scopes.map((scope) => (
                      <li key={scope}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-xs text-ink hover:bg-surface-hover">
                          <input
                            type="checkbox"
                            checked={selected.includes(scope)}
                            onChange={() => {
                              toggle(scope);
                            }}
                            className="accent-accent"
                          />
                          {/* The raw permission string, in mono: this is a
                              developer surface, and the string is the exact
                              value the server validates — a human label
                              would be a second vocabulary to drift. */}
                          <code className="font-mono text-xs">{scope}</code>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-faint">
            A token can only do what its scopes allow, and only while you hold those permissions
            yourself — the server re-checks against your live role on every request.
          </p>
        </div>
      </Field>

      <Field label="Expiry" htmlFor="api-token-expiry">
        <select
          id="api-token-expiry"
          value={expiresInDays}
          onChange={(event) => {
            setExpiresInDays(Number(event.target.value));
          }}
          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
        >
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
          <option value={180}>180 days</option>
          <option value={365}>1 year</option>
          <option value={0}>No expiry</option>
        </select>
        <p className="text-xs text-ink-faint">
          {expiresInDays === 0
            ? 'This token never expires — revoke it by hand when it is no longer needed.'
            : 'After this, the token stops authenticating. You can always revoke it sooner.'}
        </p>
      </Field>

      {create.isError && <ErrorText error={create.error} />}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={name.trim() === '' || selected.length === 0 || create.isPending}
        >
          {create.isPending ? 'Minting…' : 'Create token'}
        </Button>
        <button type="button" onClick={onCancel} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One credential. */
function TokenRow({
  orgId,
  token,
  canRevoke,
}: {
  readonly orgId: string;
  readonly token: TokenSummary;
  readonly canRevoke: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.apiTokens(orgId) });

  const revoke = useMutation({
    mutationFn: () => api.apiToken.revoke.mutate({ tokenId: token.tokenId }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The token could not be revoked', error);
    },
  });

  const revoked = token.revokedAt !== null;
  /* Expiry is enforced server-side at the auth lookup; this is only the
     display of it, so an expired-but-not-revoked token reads as dead rather
     than as active. */
  const expired = token.expiresAt !== null && hasPassed(token.expiresAt);
  const active = !revoked && !expired;
  const status = revoked ? 'Revoked' : expired ? 'Expired' : 'Active';

  return (
    <div className="overflow-hidden rounded-lg border border-line/50">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-surface-raised px-3 py-2">
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', active ? 'bg-success' : 'bg-danger')}
        />
        <span className="sr-only">{status}</span>

        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm font-medium',
                active ? 'text-ink' : 'text-ink-muted line-through',
              )}
            >
              {token.name}
            </span>
            {!active && (
              <span className="shrink-0 rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                {status}
              </span>
            )}
          </p>
          {/* The prefix is all the list ever sees of the credential — the
              full token is shown once at mint, and the hash is never exposed. */}
          <p className="truncate font-mono text-xs text-ink-faint">tf_pat_{token.tokenPrefix}</p>
        </div>

        <p
          className="hidden max-w-52 truncate font-mono text-xs text-ink-muted sm:block"
          title={token.scopes.join(', ')}
        >
          {token.scopes.join(', ')}
        </p>

        <p className="shrink-0 text-xs text-ink-faint">
          {token.lastUsedAt === null ? 'never used' : `used ${formatRelative(token.lastUsedAt)}`}
        </p>

        {token.expiresAt !== null && !revoked && (
          <p className={cn('shrink-0 text-xs', expired ? 'text-danger' : 'text-ink-faint')}>
            {expired
              ? `expired ${formatRelative(token.expiresAt)}`
              : `expires ${formatRelative(token.expiresAt)}`}
          </p>
        )}

        {active && canRevoke && (
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Revoking is a two-click action for the same reason deleting a
                webhook is: every script holding this credential breaks the
                instant it lands, with no read-back and no undo. */}
            <ConfirmButton
              label="Revoke"
              confirmLabel="Revoke token"
              disabled={revoke.isPending}
              className="h-6 px-1.5 text-xs"
              onConfirm={() => {
                revoke.mutate();
              }}
            />
          </div>
        )}
      </div>
      {revoke.isError && (
        <div className="border-t border-line/50 px-3 py-2">
          <ErrorText error={revoke.error} />
        </div>
      )}
    </div>
  );
}
