import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { Building2, Search, Users } from 'lucide-react';
import type { UserId } from '@taskflow/contracts';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  OrgBadge,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  DetailRow,
  ModalIconHeader,
  Pagination,
  SectionHeader,
  StatusPill,
  StepUpGate,
  TableSearch,
  downloadCsv,
} from './shared.js';

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

export function UsersTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  /** The drill-down panel's subject, or null when closed. */
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const users = useQuery({
    queryKey: keys.platformUsers(cursor),
    queryFn: async () => wire(await api.platformAdmin.users.list.query({ cursor, limit: 25 })),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['platform', 'users'] });
  };

  /* `users.suspend`/`.reactivate` have existed on the server since Phase 12
     Wave 2 (§3.1) — a change to `identity.users`, a table no org owns, which
     is why only the platform tier can authorize it. Nothing in this tab ever
     called them: the route shipped with no consumer, the identical
     "shipped backend, no UI" gap this console's own `ai-tab.tsx` header
     documents finding once already for the provider catalog. */
  const suspend = useMutation({
    mutationFn: (userId: UserId) => api.platformAdmin.users.suspend.mutate({ userId }),
    onSuccess: invalidate,
    onError: (error, userId) => {
      guard(error, () => {
        suspend.mutate(userId);
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: (userId: UserId) => api.platformAdmin.users.reactivate.mutate({ userId }),
    onSuccess: invalidate,
    onError: (error, userId) => {
      guard(error, () => {
        reactivate.mutate(userId);
      });
    },
  });

  if (errorCodeOf(users.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredUsers = users.data?.users.filter((user) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return user.email.toLowerCase().includes(q) || user.name?.toLowerCase().includes(q) === true;
  });

  return (
    <section aria-label="Users">
      <SectionHeader icon={Users} title="Users" subtitle="global directory · suspend" />
      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter users by name or email…"
        />
        {users.data !== undefined && users.data.users.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'User id',
                'Name',
                'Email',
                'Email verified',
                'Organizations',
                'Created',
              ];
              const rows = [
                header,
                ...users.data.users.map((user) => [
                  user.userId,
                  user.name ?? '',
                  user.email,
                  user.emailVerifiedAt !== null ? formatDate(user.emailVerifiedAt) : 'no',
                  String(user.orgCount),
                  formatDate(user.createdAt),
                ]),
              ];
              downloadCsv(`users-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {users.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {users.isError && <ErrorView error={users.error} title="Could not load users" />}

      {users.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  User
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Email verified
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Orgs
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Created
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {(filteredUsers ?? []).map((user) => (
                <tr
                  key={user.userId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setDetailUserId(user.userId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Avatar userId={user.userId} label={user.name ?? user.email} />
                      <div className="min-w-0">
                        <p className="max-w-full truncate font-medium text-ink transition-colors group-hover:text-accent">
                          {user.name ?? user.email}
                        </p>
                        {user.name !== null && (
                          <p className="truncate text-ink-muted">{user.email}</p>
                        )}
                        <p className="font-mono text-[11px] text-ink-faint">
                          {user.userId.slice(0, 8)}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {user.emailVerifiedAt === null ? (
                      <span className="text-ink-faint">no</span>
                    ) : (
                      <span className="text-success">{formatDate(user.emailVerifiedAt)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{user.orgCount}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {formatDate(user.createdAt)}
                  </td>
                  <td className="px-3 py-2.5">
                    <UserStatusBadge status={user.status} />
                  </td>
                  <td
                    className="px-3 py-2.5 text-right"
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {user.status === 'suspended' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={reactivate.isPending}
                        onClick={() => {
                          reactivate.mutate(user.userId as UserId);
                        }}
                      >
                        Reactivate
                      </Button>
                    ) : (
                      <ConfirmButton
                        size="sm"
                        label="Suspend"
                        confirmLabel={`Suspend ${user.name ?? user.email}?`}
                        disabled={suspend.isPending}
                        onConfirm={() => {
                          suspend.mutate(user.userId as UserId);
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {(filteredUsers ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">No users match your search.</p>
                        <p className="text-xs text-ink-faint">Try a different name or email.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Users className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No users yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Users appear here once they create an account and verify their email.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(suspend.isError || reactivate.isError) && (
        <ErrorView
          error={suspend.error ?? reactivate.error}
          title="Could not change the account status"
        />
      )}

      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (users.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(users.data?.nextCursor ?? null);
          }}
          {...(filteredUsers !== undefined
            ? { countLabel: `${String(filteredUsers.length)} users` }
            : {})}
        />
      </div>

      {detailUserId !== null && (
        <UserDetailDialog
          userId={detailUserId}
          onClose={() => {
            setDetailUserId(null);
          }}
        />
      )}
    </section>
  );
}

function UserDetailDialog({
  userId,
  onClose,
}: {
  readonly userId: string;
  readonly onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: keys.platformUserDetail(userId),
    queryFn: async () => wire(await api.platformAdmin.users.detail.query({ userId })),
  });

  const data = detail.data;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="max-h-[85vh] overflow-y-auto p-5">
        <ModalIconHeader
          icon={Users}
          tone="accent"
          identity={
            data !== undefined && (
              <Avatar userId={data.userId} label={data.name ?? data.email} size="lg" />
            )
          }
        >
          <ModalTitle>{data?.name ?? data?.email ?? 'Account'}</ModalTitle>
          <ModalDescription>
            {data === undefined
              ? 'Loading…'
              : `${data.email} · joined ${formatDate(data.createdAt)}`}
          </ModalDescription>
        </ModalIconHeader>

        {detail.isPending && <SkeletonRows rows={4} className="mt-4 *:h-10" />}
        {detail.isError && <ErrorView error={detail.error} title="Could not load this account" />}

        {data !== undefined && (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="contents">
                <dt className="text-ink-faint">Account status</dt>
                <dd>
                  <UserStatusBadge status={data.status} />
                </dd>
              </div>
              <DetailRow
                label="Email verified"
                value={data.emailVerifiedAt === null ? 'no' : formatDate(data.emailVerifiedAt)}
              />
              <DetailRow label="User id" value={data.userId} mono />
            </dl>

            <section>
              <SectionHeader
                icon={Building2}
                title="Organizations"
                subtitle={`${String(data.memberships.length)} membership${data.memberships.length === 1 ? '' : 's'}`}
              />

              {data.memberships.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line bg-surface-sunken/40 p-4 text-center text-xs text-ink-faint">
                  This account belongs to no organization. They can sign in and will land on the org
                  picker with nothing to choose.
                </p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {data.memberships.map((membership) => (
                    <li
                      key={membership.orgId}
                      className="px-3 py-2.5 text-xs transition-colors hover:bg-surface-hover/30"
                    >
                      <div className="flex items-center gap-2">
                        <OrgBadge orgId={membership.orgId} name={membership.orgName} />
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">
                          {membership.orgName}
                        </span>
                        <Badge>{membership.role}</Badge>
                        {membership.status !== 'active' && (
                          <span className="text-[11px] text-ink-faint">{membership.status}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {membership.orgSlug} · org {membership.orgStatus} ·{' '}
                        {membership.orgBillingStatus} · since {formatDate(membership.joinedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex justify-end">
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </ModalContent>
    </ModalRoot>
  );
}

/** Same shape as `orgs-tab.tsx`'s own `StatusBadge` — both are `StatusPill`
    now, sharing the same rendering; only the vocabulary differs. */
function UserStatusBadge({ status }: { readonly status: string }) {
  if (status === 'suspended') {
    return <StatusPill tone="danger" label="suspended" className="min-w-[80px]" />;
  }
  return <StatusPill tone="success" label="active" className="min-w-[80px]" />;
}
