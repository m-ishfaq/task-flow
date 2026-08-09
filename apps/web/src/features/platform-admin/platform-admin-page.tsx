import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import type { FlagName } from '@taskflow/feature-flags';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Input,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useStepUp } from '../auth/use-step-up.js';

/**
 * The platform-operator console (Phase 12 §3.2, §3.6-§3.10).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — the client half of a new privilege-
 * escalation surface.
 *
 * ## This page never decides who may see it
 *
 * §8.2's rule holds here exactly as it does everywhere else in this app: the
 * UI never re-derives authorization. `AccountMenu` in `components/shell.tsx`
 * already used `self.check` to decide whether to render a LINK here, but
 * that was only ever a courtesy — a non-operator can still type this URL
 * directly. So every tab below fires its real `platformAdmin.*` query
 * immediately, with no gate of its own, and a non-operator's FIRST query
 * comes back `FORBIDDEN` from the server's `platformRoute` check and
 * renders through the ordinary `ErrorView`. There is no separate
 * "you don't have access" screen to keep in sync with the server's answer.
 */
export function PlatformAdminPage() {
  const [tab, setTab] = useState<'orgs' | 'users' | 'flags' | 'audit'>('orgs');

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Platform admin</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Cross-tenant org governance. Every action here is written to the operator
          accountability log, including reads.
        </p>
      </div>

      <div className="flex gap-1 border-b border-line" role="tablist">
        {(
          [
            { id: 'orgs', label: 'Organizations' },
            { id: 'users', label: 'Users' },
            { id: 'flags', label: 'Flags' },
            { id: 'audit', label: 'Audit' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
            }}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium',
              tab === item.id
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'orgs' && <OrgsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'flags' && <FlagsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Organizations
 * -------------------------------------------------------------------------- */

function OrgsTab() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const orgs = useQuery({
    queryKey: keys.platformAdminOrgs(cursor, search),
    queryFn: async () =>
      wire(await api.platformAdmin.orgs.list.query({ limit: 50, before: cursor, search: search || null })),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['platform-admin', 'orgs'] });

  const suspend = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.suspend.mutate({ orgId }),
    onSuccess: refresh,
    onError: (error, orgId) => {
      guard(error, () => {
        suspend.mutate(orgId);
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.reactivate.mutate({ orgId }),
    onSuccess: refresh,
    onError: (error, orgId) => {
      guard(error, () => {
        reactivate.mutate(orgId);
      });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Input
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setCursor(null);
        }}
        placeholder="Search by name or slug…"
        className="max-w-xs"
      />

      {(suspend.isError || reactivate.isError) && (
        <ErrorView error={suspend.error ?? reactivate.error} title="Could not update this organization" />
      )}

      {orgs.isPending && <SkeletonRows />}
      {orgs.isError && <ErrorView error={orgs.error} title="Could not load organizations" />}

      {orgs.data !== undefined &&
        (orgs.data.orgs.length === 0 ? (
          <Empty title="No organizations found" />
        ) : (
          <>
            <div className="overflow-x-auto rounded border border-line">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Slug</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Members</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {orgs.data.orgs.map((org) => (
                    <tr key={org.orgId} className="border-b border-line/50 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-ink">{org.name}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-ink-muted">{org.slug}</td>
                      <td className="px-3 py-1.5">
                        <Badge
                          className={cn(
                            org.status === 'active' && 'bg-success/10 text-success',
                            org.status === 'suspended' && 'bg-danger/10 text-danger',
                          )}
                        >
                          {org.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-ink-muted">{org.memberCount}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{formatDateTime(org.createdAt)}</td>
                      <td className="px-3 py-1.5 text-right">
                        {org.status === 'active' ? (
                          <ConfirmButton
                            label="Suspend"
                            confirmLabel="Confirm suspend"
                            disabled={suspend.isPending}
                            onConfirm={() => {
                              suspend.mutate(org.orgId as OrgId);
                            }}
                          />
                        ) : org.status === 'suspended' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={reactivate.isPending}
                            onClick={() => {
                              reactivate.mutate(org.orgId as OrgId);
                            }}
                          >
                            Reactivate
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <Button
                disabled={cursor === null}
                onClick={() => {
                  setCursor(null);
                }}
              >
                Newest
              </Button>
              <Button
                disabled={orgs.data.nextCursor === null}
                onClick={() => {
                  setCursor(orgs.data.nextCursor);
                }}
              >
                Older
              </Button>
            </div>
          </>
        ))}

      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

function UsersTab() {
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const users = useQuery({
    queryKey: keys.platformAdminUsers(cursor, search),
    queryFn: async () =>
      wire(await api.platformAdmin.users.list.query({ limit: 50, before: cursor, search: search || null })),
  });

  return (
    <div className="flex flex-col gap-4">
      <Input
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setCursor(null);
        }}
        placeholder="Search by email…"
        className="max-w-xs"
      />

      {users.isPending && <SkeletonRows />}
      {users.isError && <ErrorView error={users.error} title="Could not load users" />}

      {users.data !== undefined &&
        (users.data.users.length === 0 ? (
          <Empty title="No users found" />
        ) : (
          <>
            <div className="overflow-x-auto rounded border border-line">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Verified</th>
                    <th className="px-3 py-2 font-medium">Orgs</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.users.map((user) => (
                    <tr key={user.userId} className="border-b border-line/50 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-ink">{user.email}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{user.status}</td>
                      <td className="px-3 py-1.5 text-ink-muted">
                        {user.emailVerifiedAt !== null ? formatDateTime(user.emailVerifiedAt) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-ink-muted">{user.orgCount}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{formatDateTime(user.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <Button
                disabled={cursor === null}
                onClick={() => {
                  setCursor(null);
                }}
              >
                Newest
              </Button>
              <Button
                disabled={users.data.nextCursor === null}
                onClick={() => {
                  setCursor(users.data.nextCursor);
                }}
              >
                Older
              </Button>
            </div>
          </>
        ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Flags
 * -------------------------------------------------------------------------- */

function FlagsTab() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();

  const flags = useQuery({
    queryKey: keys.platformAdminFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.platformAdminFlags() });

  const set = useMutation({
    mutationFn: (input: { flag: FlagName; value: boolean }) => api.platformAdmin.flags.set.mutate(input),
    onSuccess: refresh,
    onError: (error, input) => {
      guard(error, () => {
        set.mutate(input);
      });
    },
  });

  const clear = useMutation({
    mutationFn: (flag: FlagName) => api.platformAdmin.flags.clear.mutate({ flag }),
    onSuccess: refresh,
    onError: (error, flag) => {
      guard(error, () => {
        clear.mutate(flag);
      });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {(set.isError || clear.isError) && (
        <ErrorView error={set.error ?? clear.error} title="Could not update this flag" />
      )}

      {flags.isPending && <SkeletonRows />}
      {flags.isError && <ErrorView error={flags.error} title="Could not load flags" />}

      {flags.data !== undefined &&
        (flags.data.length === 0 ? (
          <Empty title="No flags registered" />
        ) : (
          <div className="overflow-x-auto rounded border border-line">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Flag</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {flags.data.map((row) => (
                  <tr key={row.flag} className="border-b border-line/50 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs text-ink">{row.flag}</td>
                    <td className="px-3 py-1.5 text-ink-muted">{row.description}</td>
                    <td className="px-3 py-1.5">
                      <Badge className={cn(row.value && 'bg-success/10 text-success')}>
                        {row.value ? 'on' : 'off'}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-ink-muted">
                      {row.source === 'platform-override' ? 'override' : 'default'}
                      {row.updatedAt !== null && (
                        <span className="ml-1 text-[11px] text-ink-faint">
                          {formatDateTime(row.updatedAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={set.isPending}
                          onClick={() => {
                            set.mutate({ flag: row.flag, value: !row.value });
                          }}
                        >
                          {row.value ? 'Turn off' : 'Turn on'}
                        </Button>
                        {row.source === 'platform-override' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={clear.isPending}
                            onClick={() => {
                              clear.mutate(row.flag);
                            }}
                          >
                            Clear override
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {dialog}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Audit
 * -------------------------------------------------------------------------- */

function AuditTab() {
  const [before, setBefore] = useState<string | null>(null);

  const entries = useQuery({
    queryKey: keys.platformAdminAudit(before),
    queryFn: async () => wire(await api.platformAdmin.audit.list.query({ limit: 50, before })),
  });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        Every `platformAdmin.*` call, including reads — this is the operator
        accountability log, not the target organization's own audit log.
      </p>

      {entries.isPending && <SkeletonRows />}
      {entries.isError && <ErrorView error={entries.error} title="Could not load the operator audit log" />}

      {entries.data !== undefined &&
        (entries.data.length === 0 ? (
          <Empty title="Nothing recorded yet" />
        ) : (
          <>
            <div className="overflow-x-auto rounded border border-line">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 font-medium">Seq</th>
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Operator</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data.map((entry) => (
                    <tr key={entry.seq} className="border-b border-line/50 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-ink-faint">{entry.seq}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-ink-muted">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-ink-muted">
                        {entry.operatorId.slice(0, 8)}
                      </td>
                      <td className="px-3 py-1.5 font-medium text-ink">{entry.action}</td>
                      <td className="px-3 py-1.5 font-mono text-[10px] text-ink-faint">
                        {entry.target !== null && entry.target !== undefined
                          ? JSON.stringify(entry.target)
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-2">
              <Button
                disabled={before === null}
                onClick={() => {
                  setBefore(null);
                }}
              >
                Newest
              </Button>
              <Button
                disabled={entries.data.length < 50}
                onClick={() => {
                  setBefore(entries.data[entries.data.length - 1]?.seq ?? null);
                }}
              >
                Older
              </Button>
            </div>
          </>
        ))}
    </div>
  );
}
