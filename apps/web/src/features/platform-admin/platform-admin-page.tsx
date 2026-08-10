import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import type { OrgId } from '@taskflow/contracts';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useStepUp } from '../auth/use-step-up.js';
import { StepUpDialog } from '../auth/step-up.js';

/**
 * The platform administration console (Phase 12 Wave 1, ai/phase-12-admin.md).
 *
 * ## What this page is
 *
 * The ONE place in the app that is relative to no organization. Every query and
 * mutation behind it is `platformRoute` — authenticated, checked against the
 * `platform.operators` flag, and (unconditionally) step-up. It is reachable
 * with no org selected, which is why the route guard is `requireSession` and
 * why its query keys are deliberately not org-prefixed.
 *
 * ## Step-up, and why even the READS prompt for it
 *
 * `platformRoute` bakes `stepUp: true` into every call, reads included — a
 * cross-tenant read is as sensitive as a cross-tenant write, and the operator
 * tier is exactly what a stolen session is for. So a session older than the
 * five-minute proof window answers STEP_UP_REQUIRED on the first data query.
 * Mutations use the standard `useStepUp` guard/retry pair; a QUERY has no
 * thunk to replay, so each tab renders a "re-authenticate" gate instead, and
 * confirming invalidates every platform key so the queries refetch under the
 * fresh credential.
 *
 * ## A non-operator landing here
 *
 * There is no `isOperator` check on the page. The account menu hides the link
 * from everyone the server answers "no" to, and a non-operator who types the
 * URL anyway gets the honest thing: every query answers FORBIDDEN and the tab
 * renders `ErrorView`. The UI never re-derives authorization (§8.2) — the
 * server's answer is the access-denied screen.
 */
export function PlatformAdminPage() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [gateOpen, setGateOpen] = useState(false);
  const [tab, setTab] = useState<'orgs' | 'users' | 'flags' | 'audit'>('orgs');

  /* The query-side step-up gate (see the header comment). Confirming runs the
     same login the mutation dialog runs; invalidating every `['platform']` key
     makes the active tab's query refetch under the fresh authenticatedAt. */
  const onProof = () => {
    setGateOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-lg font-semibold text-ink">Platform administration</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every organization, user, and release flag. There is no organization selected here on
          purpose — this console spans them all.
        </p>
      </header>

      {/* Tabs, not routes: the console is one surface with four views, and a
          child route per tab would mount a fresh component tree on every
          switch for no benefit — the queries are already keyed per page. */}
      <div
        role="tablist"
        aria-label="Platform administration sections"
        className="flex gap-1 rounded-lg border border-line bg-surface-sunken p-1"
      >
        {(
          [
            ['orgs', 'Organizations'],
            ['users', 'Users'],
            ['flags', 'Feature flags'],
            ['audit', 'Operator audit'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
            }}
            className={cn(
              'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === value
                ? 'bg-surface-raised text-ink shadow-sm'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'orgs' && (
        <OrgsTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'users' && (
        <UsersTab
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'flags' && (
        <FlagsTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'audit' && (
        <AuditTab
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}

      {/* The mutation dialog (useStepUp) and the query gate dialog. Only one is
          ever open — the other renders nothing when closed. */}
      {dialog}
      {gateOpen && (
        <StepUpDialog
          open
          onClose={() => {
            setGateOpen(false);
          }}
          onConfirmed={onProof}
        />
      )}
    </div>
  );
}

/**
 * The read gate every tab renders when its query hits STEP_UP_REQUIRED.
 *
 * Separate from `useStepUp`'s mutation flow because a query cannot be replayed
 * as a thunk — the tab's content only exists once the data does.
 */
function StepUpGate({ onStepUp }: { readonly onStepUp: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface-raised p-4">
      <p className="text-sm text-ink">
        Platform administration needs a fresh sign-in. Your last one is more than five minutes old.
      </p>
      <Button variant="primary" onClick={onStepUp}>
        Re-authenticate
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Organizations
 * -------------------------------------------------------------------------- */

function OrgsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);

  const orgs = useQuery({
    queryKey: keys.platformOrgs(cursor),
    queryFn: async () => wire(await api.platformAdmin.orgs.list.query({ cursor, limit: 25 })),
  });

  const suspend = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.suspend.mutate({ orgId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, orgId) => {
      guard(error, () => {
        suspend.mutate(orgId);
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.reactivate.mutate({ orgId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, orgId) => {
      guard(error, () => {
        reactivate.mutate(orgId);
      });
    },
  });

  /* §3.5 (Phase 12 Wave 2) — org deletion, the one action with no undo. The
     row's Delete button only opens the modal for a SUSPENDED org (the server
     enforces the gate too); the modal's confirm button stays disabled until
     the operator types the org's exact slug, and the server re-checks both. */
  const [deleteTarget, setDeleteTarget] = useState<{
    orgId: string;
    name: string;
    slug: string;
  } | null>(null);
  const [confirmSlug, setConfirmSlug] = useState('');

  const remove = useMutation({
    mutationFn: (input: { orgId: OrgId; confirmSlug: string }) =>
      api.platformAdmin.orgs.delete.mutate(input),
    onSuccess: async () => {
      setDeleteTarget(null);
      setConfirmSlug('');
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, input) => {
      guard(error, () => {
        remove.mutate(input);
      });
    },
  });

  if (errorCodeOf(orgs.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  return (
    <section aria-label="Organizations">
      {orgs.isPending && <SkeletonRows rows={5} className="*:h-12" />}
      {orgs.isError && <ErrorView error={orgs.error} title="Could not load organizations" />}

      {orgs.data !== undefined && (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-ink-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Organization</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Members</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {orgs.data.orgs.map((org) => (
                <tr key={org.orgId} className="border-b border-line/50 last:border-0">
                  <td className="px-3 py-2">
                    <p className="font-medium text-ink">{org.name}</p>
                    <p className="font-mono text-[10px] text-ink-faint">{org.slug}</p>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={org.status} />
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{org.memberCount}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                    {formatDate(org.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {org.status === 'suspended' ? (
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reactivate.isPending}
                          onClick={() => {
                            reactivate.mutate(org.orgId as OrgId);
                          }}
                        >
                          Reactivate
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={remove.isPending}
                          onClick={() => {
                            setConfirmSlug('');
                            setDeleteTarget({ orgId: org.orgId, name: org.name, slug: org.slug });
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    ) : (
                      <ConfirmButton
                        size="sm"
                        label="Suspend"
                        confirmLabel={`Suspend ${org.name}?`}
                        disabled={suspend.isPending}
                        onConfirm={() => {
                          suspend.mutate(org.orgId as OrgId);
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(suspend.isError || reactivate.isError || remove.isError) && (
        <ErrorView
          error={suspend.error ?? reactivate.error ?? remove.error}
          title="Could not change the status"
        />
      )}

      {/* §3.5's type-the-slug confirmation — a single confirm-button click is
          too cheap an action to gate the one operation in this system with no
          undo. The button is disabled until the typed slug matches exactly;
          the server re-checks the slug AND the suspended status. */}
      {deleteTarget !== null && (
        <ModalRoot
          open
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null);
          }}
        >
          <ModalContent size="sm" className="p-4">
            <ModalTitle>Delete {deleteTarget.name}?</ModalTitle>
            <ModalDescription>
              This permanently deletes the organization and everything it owns — projects, channels,
              documents, memberships, and its audit history. There is no undo. Type{' '}
              <code className="rounded bg-surface-sunken px-1 font-mono text-[11px]">
                {deleteTarget.slug}
              </code>{' '}
              to confirm.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (deleteTarget !== null && confirmSlug === deleteTarget.slug) {
                  remove.mutate({
                    orgId: deleteTarget.orgId as OrgId,
                    confirmSlug,
                  });
                }
              }}
            >
              <Field label="Type the organization slug" htmlFor="delete-org-slug">
                <Input
                  id="delete-org-slug"
                  value={confirmSlug}
                  autoComplete="off"
                  placeholder={deleteTarget.slug}
                  onChange={(event) => {
                    setConfirmSlug(event.target.value);
                  }}
                />
              </Field>

              {remove.isError && <ErrorView error={remove.error} />}

              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="danger"
                  disabled={remove.isPending || confirmSlug !== deleteTarget.slug}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete forever'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDeleteTarget(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </ModalContent>
        </ModalRoot>
      )}

      {/* Keyset pagination on created_at — a directory read while orgs are
          being created must not shift under the reader. */}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          disabled={cursor === null}
          onClick={() => {
            setCursor(null);
          }}
        >
          Newest
        </Button>
        <Button
          variant="secondary"
          disabled={orgs.data?.nextCursor === null}
          onClick={() => {
            setCursor(orgs.data?.nextCursor ?? null);
          }}
        >
          Older
        </Button>
      </div>
    </section>
  );
}

/** The one column in the org directory that has meaning beyond itself. */
function StatusBadge({ status }: { readonly status: string }) {
  if (status === 'suspended') {
    return <Badge className="border-danger/40 bg-danger/10 text-danger">suspended</Badge>;
  }
  if (status === 'deleted') {
    return <Badge className="border-line bg-surface-sunken text-ink-faint">deleted</Badge>;
  }
  return <Badge className="border-success/40 bg-success/10 text-success">active</Badge>;
}

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

function UsersTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);

  const users = useQuery({
    queryKey: keys.platformUsers(cursor),
    queryFn: async () => wire(await api.platformAdmin.users.list.query({ cursor, limit: 25 })),
  });

  if (errorCodeOf(users.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  return (
    <section aria-label="Users">
      {users.isPending && <SkeletonRows rows={5} className="*:h-12" />}
      {users.isError && <ErrorView error={users.error} title="Could not load users" />}

      {users.data !== undefined && (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-ink-faint">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Email verified</th>
                <th className="px-3 py-2 font-medium">Orgs</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((user) => (
                <tr key={user.userId} className="border-b border-line/50 last:border-0">
                  <td className="px-3 py-2">
                    {/* Null for an account that never set a profile name, which
                        is why this renders conditionally rather than falling
                        back to the email — that is already the line below. */}
                    {user.name !== null && <p className="truncate text-ink">{user.name}</p>}
                    <p className="truncate text-ink">{user.email}</p>
                    <p className="font-mono text-[10px] text-ink-faint">
                      {user.userId.slice(0, 8)}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {user.emailVerifiedAt === null ? 'no' : formatDate(user.emailVerifiedAt)}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{user.orgCount}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                    {formatDate(user.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          disabled={cursor === null}
          onClick={() => {
            setCursor(null);
          }}
        >
          Newest
        </Button>
        <Button
          variant="secondary"
          disabled={users.data?.nextCursor === null}
          onClick={() => {
            setCursor(users.data?.nextCursor ?? null);
          }}
        >
          Older
        </Button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Feature flags
 * -------------------------------------------------------------------------- */

function FlagsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const flags = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

  /* `flagName` is typed `string` on the client (zod's `.refine()` does not
     narrow the inferred type) and re-validated against FLAG_NAMES by the
     route — the names here come from the server's own registry list, so
     passing them straight back needs no cast. */
  const set = useMutation({
    mutationFn: (input: { flagName: string; value: boolean | null }) =>
      api.platformAdmin.flags.set.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.platformFlags() });
    },
    onError: (error, input) => {
      guard(error, () => {
        set.mutate(input);
      });
    },
  });

  if (errorCodeOf(flags.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  return (
    <section aria-label="Feature flags">
      <p className="text-xs text-ink-muted">
        Global overrides — the table the evaluator never had. A toggle here changes what every
        organization resolves until the override is reset.
      </p>

      {flags.isPending && <SkeletonRows rows={5} className="*:h-16" />}
      {flags.isError && <ErrorView error={flags.error} title="Could not load flags" />}

      {flags.data !== undefined &&
        (flags.data.length === 0 ? (
          <Empty title="No flags registered" />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {flags.data.map((flag) => (
              <li key={flag.flagName} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                    {flag.flagName}
                    <span className="font-mono text-[10px] text-ink-faint">Phase {flag.phase}</span>
                    {flag.perOrg && (
                      <span className="text-[10px] text-ink-faint">org-toggleable</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-ink-muted">{flag.description}</p>
                  <p className="text-[10px] text-ink-faint">
                    {flag.source === 'override' ? (
                      <>
                        overridden — default was {String(flag.defaultValue)}
                        {flag.overrideSetAt !== null && `, set ${formatDate(flag.overrideSetAt)}`}
                      </>
                    ) : (
                      'using the registry default'
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {flag.source === 'override' && (
                    <button
                      type="button"
                      disabled={set.isPending}
                      onClick={() => {
                        set.mutate({ flagName: flag.flagName, value: null });
                      }}
                      className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-hover hover:text-ink"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flag.value}
                    aria-label={`${flag.flagName} ${flag.value ? 'on' : 'off'}`}
                    disabled={set.isPending}
                    onClick={() => {
                      set.mutate({ flagName: flag.flagName, value: !flag.value });
                    }}
                    className={cn(
                      'relative h-5 w-9 rounded-full border transition-colors',
                      flag.value
                        ? 'border-accent bg-accent'
                        : 'border-line bg-surface-sunken hover:bg-surface-hover',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-0.5 size-3.5 rounded-full bg-surface-raised shadow-sm transition-transform',
                        flag.value ? 'translate-x-[18px]' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {set.isError && <ErrorView error={set.error} title="Could not change the flag" />}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Operator audit
 * -------------------------------------------------------------------------- */

function AuditTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const [before, setBefore] = useState<string | null>(null);

  const entries = useQuery({
    queryKey: keys.platformAudit(before),
    queryFn: async () => wire(await api.platformAdmin.audit.list.query({ limit: 50, before })),
  });

  if (errorCodeOf(entries.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  return (
    <section aria-label="Operator audit">
      <p className="text-xs text-ink-muted">
        Every platform-admin call lands in a global hash chain — the accountability record of this
        tier itself. Reading it is recorded too.
      </p>

      {entries.isPending && <Spinner />}
      {entries.isError && (
        <ErrorView error={entries.error} title="Could not load the operator audit" />
      )}

      {entries.data !== undefined &&
        (entries.data.entries.length === 0 ? (
          <Empty title="Nothing recorded yet" />
        ) : (
          <>
            <div className="overflow-x-auto rounded border border-line">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Seq</th>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Operator</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data.entries.map((entry) => (
                    <tr key={entry.seq} className="border-b border-line/50 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-ink-faint">{entry.seq}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-ink-muted">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-3 py-1.5 font-medium text-ink">{entry.action}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-ink-muted">
                        {entry.target === null ? '—' : JSON.stringify(entry.target)}
                      </td>
                      <td className="px-3 py-1.5 text-ink-muted">
                        <span className="truncate" title={entry.operatorId}>
                          {entry.operatorEmail}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Keyset pagination on seq — the same reasoning as the org audit:
                an append-only log must not shift under a reader. */}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={before === null}
                onClick={() => {
                  setBefore(null);
                }}
              >
                Newest
              </Button>
              <Button
                variant="secondary"
                disabled={entries.data.entries.length < 50}
                onClick={() => {
                  setBefore(entries.data.entries[entries.data.entries.length - 1]?.seq ?? null);
                }}
              >
                Older
              </Button>
            </div>
          </>
        ))}
    </section>
  );
}
