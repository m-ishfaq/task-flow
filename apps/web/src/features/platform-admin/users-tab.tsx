import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { Search, Users } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { DetailRow, Pagination, StepUpGate, TableSearch, downloadCsv } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

export function UsersTab({ onStepUp }: { readonly onStepUp: () => void }) {
  /** The drill-down panel's subject, or null when closed. */
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const users = useQuery({
    queryKey: keys.platformUsers(cursor),
    queryFn: async () => wire(await api.platformAdmin.users.list.query({ cursor, limit: 25 })),
  });

  if (errorCodeOf(users.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredUsers = users.data?.users.filter((user) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return user.email.toLowerCase().includes(q) || user.name?.toLowerCase().includes(q) === true;
  });

  return (
    <section aria-label="Users">
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
                    <p className="max-w-full truncate font-medium text-ink transition-colors group-hover:text-accent">
                      {user.name ?? user.email}
                    </p>
                    {user.name !== null && <p className="truncate text-ink-muted">{user.email}</p>}
                    <p className="font-mono text-[11px] text-ink-faint">
                      {user.userId.slice(0, 8)}
                    </p>
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
                </tr>
              ))}
              {(filteredUsers ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-12 text-center">
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
        <ModalTitle>{data?.name ?? data?.email ?? 'Account'}</ModalTitle>
        <ModalDescription>
          {data === undefined ? 'Loading…' : `${data.email} · joined ${formatDate(data.createdAt)}`}
        </ModalDescription>

        {detail.isPending && <SkeletonRows rows={4} className="mt-4 *:h-10" />}
        {detail.isError && <ErrorView error={detail.error} title="Could not load this account" />}

        {data !== undefined && (
          <div className="mt-4 flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <DetailRow label="Account status" value={data.status} />
              <DetailRow
                label="Email verified"
                value={data.emailVerifiedAt === null ? 'no' : formatDate(data.emailVerifiedAt)}
              />
              <DetailRow label="User id" value={data.userId} mono />
            </dl>

            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">
                Organizations ({data.memberships.length})
              </h3>

              {data.memberships.length === 0 ? (
                <Empty
                  icon={<Users size={20} />}
                  title="No organizations"
                  description="This account belongs to no organization. They can sign in and will land on the org picker with nothing to choose."
                />
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {data.memberships.map((membership) => (
                    <li
                      key={membership.orgId}
                      className="px-3 py-2.5 text-xs transition-colors hover:bg-surface-hover/30"
                    >
                      <div className="flex items-center gap-2">
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
