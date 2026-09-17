import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Users } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, StepUpGate, TableSearch, downloadCsv } from './shared.js';
import { UserDetailPanel } from './user-detail-panel.js';

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

export function UsersTab({ onStepUp }: { readonly onStepUp: () => void }) {
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
                'Status',
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
                  user.status,
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
        <div className="mt-3 overflow-x-auto rounded-xl bg-surface-raised shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line/50">
                <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  User
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Email verified
                </th>
                <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Orgs
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/30">
              {(filteredUsers ?? []).map((user) => (
                <tr
                  key={user.userId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/40"
                  onClick={() => {
                    setDetailUserId(user.userId);
                  }}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink transition-colors group-hover:text-accent">
                      {user.name ?? user.email}
                    </p>
                    {user.name !== null && (
                      <p className="text-[11px] text-ink-muted">{user.email}</p>
                    )}
                    <p className="font-mono text-[11px] text-ink-faint">
                      {user.userId.slice(0, 8)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        user.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : user.status === 'suspended'
                            ? 'bg-red-500/10 text-red-400'
                            : 'bg-zinc-500/10 text-zinc-400'
                      }`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {user.emailVerifiedAt === null ? (
                      <span className="text-ink-faint">no</span>
                    ) : (
                      <span className="text-success">{formatDate(user.emailVerifiedAt)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-ink-muted">{user.orgCount}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                    {formatDate(user.createdAt)}
                  </td>
                </tr>
              ))}
              {(filteredUsers ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-16 text-center">
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
        <UserDetailPanel
          userId={detailUserId}
          onClose={() => {
            setDetailUserId(null);
          }}
        />
      )}
    </section>
  );
}
