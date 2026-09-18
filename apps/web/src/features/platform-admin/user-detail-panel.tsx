import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  Check,
  Globe,
  Key,
  Laptop,
  Lock,
  Mail,
  Shield,
  Smartphone,
  User,
  Users,
  X,
} from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button, SkeletonRows } from '../../components/primitives.js';
import { StatusPill } from '@taskflow/ui';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, DetailRow, relativeTime } from './shared.js';

/* -------------------------------------------------------------------------- *
 * UserDetailPanel — slide-over detail view for one user account
 *
 * Maximum information density: stats row, account info, security inventory,
 * session list, passkey/TOTP/OAuth status, API tokens, and every org
 * membership with role and org status.
 * -------------------------------------------------------------------------- */

const ROLE_TONES: Record<string, 'success' | 'danger' | 'neutral'> = {
  owner: 'success',
  admin: 'danger',
  guest: 'neutral',
};

const ORG_STATUS_TONES: Record<string, 'success' | 'neutral' | 'danger'> = {
  active: 'success',
  suspended: 'danger',
};

const ORG_STATUS_LABELS: Record<string, string> = {
  active: 'active',
  suspended: 'org suspended',
};

const OAUTH_ICONS: Record<string, typeof Globe> = {
  google: Globe,
  github: Laptop,
};

function MembershipRoleBadge({ role }: { readonly role: string }) {
  return (
    <StatusPill
      tone={ROLE_TONES[role] ?? 'neutral'}
      className="min-w-12 justify-center text-[10px]"
    >
      {role}
    </StatusPill>
  );
}

function OrgStatusBadge({ status }: { readonly status: string }) {
  return (
    <StatusPill tone={ORG_STATUS_TONES[status] ?? 'neutral'} className="text-[10px]">
      {ORG_STATUS_LABELS[status] ?? status}
    </StatusPill>
  );
}

/** Compact row for sessions, passkeys, tokens. */
function InfoRow({
  icon: Icon,
  label,
  value,
  badge,
  mono,
}: {
  readonly icon: typeof Globe;
  readonly label: string;
  readonly value: string;
  readonly badge?: React.ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Icon className="size-3.5 shrink-0 text-ink-muted" strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{label}</span>
      <span className={`truncate text-[11px] text-ink ${mono ? 'font-mono' : ''}`}>{value}</span>
      {badge}
    </div>
  );
}

/** Section header with icon. */
function SectionHeader({
  icon: Icon,
  title,
  count,
}: {
  readonly icon: typeof Shield;
  readonly title: string;
  readonly count?: number;
}) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-ink">
      <Icon className="size-3.5 text-ink-muted" strokeWidth={2} />
      {title}
      {count !== undefined && (
        <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-ink-faint">
          {count}
        </span>
      )}
    </h3>
  );
}

export function UserDetailPanel({
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
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-label="User inspector"
        className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-lg flex-col border-l border-line/50 bg-surface shadow-[−24px_0_60px_-12px_rgba(0,0,0,0.5)] transition-transform duration-200 ease-out"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-line/50 px-5 py-4">
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
          </button>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10">
            <User className="size-4.5 text-accent" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">
              {data?.name ?? data?.email ?? 'User'}
            </h2>
            <p className="truncate text-xs text-ink-muted">
              {data === undefined
                ? 'Loading…'
                : `${data.email} · joined ${formatDate(data.createdAt)}`}
            </p>
          </div>
          {data !== undefined && (
            <StatusPill
              tone={data.status === 'active' ? 'success' : 'danger'}
              className="shrink-0 text-[10px]"
            >
              {data.status}
            </StatusPill>
          )}
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-5">
          {detail.isPending && <SkeletonRows rows={8} className="*:h-12" />}
          {detail.isError && <ErrorView error={detail.error} title="Could not load this account" />}

          {data !== undefined && (
            <div className="flex flex-col gap-5">
              {/* ── Stats row ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Orgs" value={data.memberships.length} icon={Building2} accent />
                <StatCard
                  label="Sessions"
                  value={data.activeSessionCount}
                  icon={Smartphone}
                  accent={data.activeSessionCount > 0}
                />
                <StatCard
                  label="Passkeys"
                  value={data.passkeys.length}
                  icon={Key}
                  accent={data.passkeys.length > 0}
                />
                <StatCard
                  label="API Tokens"
                  value={data.apiTokenCount}
                  icon={Lock}
                  accent={data.apiTokenCount > 0}
                />
              </div>

              {/* ── Account info ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <SectionHeader icon={Shield} title="Account" />
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <DetailRow label="Status" value={data.status} />
                  <DetailRow
                    label="Email verified"
                    value={data.emailVerifiedAt === null ? 'no' : formatDate(data.emailVerifiedAt)}
                  />
                  <DetailRow label="Email" value={data.email} />
                  {data.name !== null && <DetailRow label="Name" value={data.name} />}
                  <DetailRow label="User id" value={data.userId} mono />
                  <DetailRow label="Account age" value={relativeTime(new Date(data.createdAt))} />
                  <DetailRow
                    label="Password"
                    value={
                      data.hasPassword
                        ? data.passwordUpdatedAt !== null
                          ? `set ${formatDate(data.passwordUpdatedAt)}`
                          : 'set'
                        : 'none (passkey-only)'
                    }
                  />
                  <DetailRow
                    label="Failed logins"
                    value={
                      data.lockedUntil !== null
                        ? `locked until ${formatDate(data.lockedUntil)}`
                        : data.failedLoginCount === 0
                          ? 'none'
                          : String(data.failedLoginCount) + ' attempts'
                    }
                  />
                </dl>

                {/* Verification indicator */}
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface p-3">
                  {data.emailVerifiedAt !== null ? (
                    <>
                      <span className="flex size-6 items-center justify-center rounded-full bg-success/10">
                        <Check className="size-3.5 text-success" strokeWidth={2.5} />
                      </span>
                      <span className="text-xs text-ink">
                        Email verified {formatDate(data.emailVerifiedAt)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex size-6 items-center justify-center rounded-full bg-warning/10">
                        <Mail className="size-3.5 text-warning" strokeWidth={2.5} />
                      </span>
                      <span className="text-xs text-ink">
                        Email not verified — account may be incomplete
                      </span>
                    </>
                  )}
                </div>
              </section>

              {/* ── Security inventory ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <SectionHeader icon={Lock} title="Security" />

                {/* TOTP */}
                <InfoRow
                  icon={Shield}
                  label="Two-factor (TOTP)"
                  value={data.totpEnabled ? 'enabled' : 'not enabled'}
                  badge={
                    data.totpEnabled ? (
                      <StatusPill tone="success" className="text-[9px]">
                        on
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral" className="text-[9px]">
                        off
                      </StatusPill>
                    )
                  }
                />

                {/* OAuth providers */}
                {data.oauthProviders.length > 0 ? (
                  data.oauthProviders.map((p) => {
                    const Icon = OAUTH_ICONS[p.provider] ?? Globe;
                    return (
                      <InfoRow
                        key={p.provider}
                        icon={Icon}
                        label={`${p.provider} connected`}
                        value={p.email}
                        mono
                      />
                    );
                  })
                ) : (
                  <InfoRow icon={Globe} label="OAuth providers" value="none linked" />
                )}

                {/* Passkeys */}
                {data.passkeys.length > 0 ? (
                  data.passkeys.map((pk) => (
                    <InfoRow
                      key={pk.id}
                      icon={Key}
                      label={pk.name ?? 'Passkey'}
                      value={`${pk.deviceType}${pk.backedUp ? ' · backed up' : ''}`}
                      badge={
                        pk.lastUsedAt !== null ? (
                          <span className="text-[9px] text-ink-faint">
                            used {relativeTime(new Date(pk.lastUsedAt))}
                          </span>
                        ) : undefined
                      }
                    />
                  ))
                ) : (
                  <InfoRow icon={Key} label="Passkeys" value="none registered" />
                )}
              </section>

              {/* ── Active sessions ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <SectionHeader icon={Smartphone} title="Sessions" count={data.activeSessionCount} />
                {data.sessions.length === 0 ? (
                  <p className="text-[11px] text-ink-faint">No active sessions.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {data.sessions.map((session) => (
                      <li
                        key={session.id}
                        className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover/40"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-surface">
                          {session.channel === 'native' ? (
                            <Smartphone className="size-3 text-ink-muted" />
                          ) : (
                            <Globe className="size-3 text-ink-muted" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium text-ink">
                              {session.country ?? 'Unknown'}
                            </span>
                            {session.flagged && (
                              <StatusPill tone="danger" className="text-[8px]">
                                flagged
                              </StatusPill>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] text-ink-faint">
                            <span className="font-mono">{session.ip ?? 'no IP'}</span>
                            <span>·</span>
                            <span>{session.channel}</span>
                            <span>·</span>
                            <span>{relativeTime(new Date(session.lastSeenAt))}</span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── API tokens ── */}
              {data.activeApiTokens.length > 0 && (
                <section className="rounded-xl bg-surface-raised p-4">
                  <SectionHeader icon={Lock} title="API Tokens" count={data.apiTokenCount} />
                  <ul className="space-y-0.5">
                    {data.activeApiTokens.map((token) => (
                      <li
                        key={token.id}
                        className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover/40"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded bg-surface">
                          <Lock className="size-3 text-ink-muted" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="truncate text-[11px] font-medium text-ink">
                            {token.name}
                          </span>
                          <div className="flex items-center gap-1.5 text-[10px] text-ink-faint">
                            <span>{token.scopes.slice(0, 3).join(', ')}</span>
                            {token.scopes.length > 3 && (
                              <span>+{token.scopes.length - 3} more</span>
                            )}
                            <span>·</span>
                            <span>created {relativeTime(new Date(token.createdAt))}</span>
                            {token.lastUsedAt !== null && (
                              <>
                                <span>·</span>
                                <span>used {relativeTime(new Date(token.lastUsedAt))}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* ── Organizations ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <SectionHeader
                  icon={Building2}
                  title="Organizations"
                  count={data.memberships.length}
                />
                {data.memberships.length === 0 ? (
                  <div className="rounded-lg bg-surface p-4 text-center">
                    <Users className="mx-auto size-6 text-ink-faint" strokeWidth={1.5} />
                    <p className="mt-2 text-xs text-ink-faint">
                      No organizations. This account can sign in but will land on an empty picker.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {data.memberships.map((membership) => (
                      <li
                        key={membership.orgId}
                        className="rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-hover/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium text-ink">
                            {membership.orgName}
                          </span>
                          <OrgStatusBadge status={membership.orgStatus} />
                          <MembershipRoleBadge role={membership.role} />
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
                          <span className="font-mono">{membership.orgSlug}</span>
                          <span>·</span>
                          <span>{membership.orgBillingStatus}</span>
                          <span>·</span>
                          <span>since {formatDate(membership.joinedAt)}</span>
                          {membership.status !== 'active' && (
                            <>
                              <span>·</span>
                              <span className="text-warning">{membership.status}</span>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-line/50 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </aside>
    </>
  );
}
