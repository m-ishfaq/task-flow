import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Mail,
  Radio,
  Send,
  Smartphone,
  Users,
} from 'lucide-react';
import type { OrgId } from '@taskflow/contracts';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Field,
  Input,
  SkeletonRows,
  Textarea,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StepUpGate, StatCard, TableSearch } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Broadcast — a message to a specific member, a role-filtered subset, or
 * every active member of one org (migration 0083). No "every org" audience
 * exists anywhere in this form on purpose — see broadcast.service.ts's own
 * header on why the blast radius stays capped at one tenant per send.
 * -------------------------------------------------------------------------- */

type AudienceTarget = 'all' | 'role' | 'users';
type MembershipRole = 'owner' | 'admin' | 'member' | 'guest';

const AUDIENCE_OPTIONS: readonly {
  readonly value: AudienceTarget;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'all', label: 'Every active member', description: 'All active members of this org' },
  { value: 'role', label: 'Members with a role', description: 'Filter by membership role' },
  { value: 'users', label: 'Specific members', description: 'Pick individual recipients' },
];

const ROLE_OPTIONS: readonly { readonly value: MembershipRole; readonly label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'guest', label: 'Guest' },
];

const CHANNEL_META: readonly {
  readonly key: 'sendPush' | 'sendEmail' | 'includeInOrgAudit';
  readonly label: string;
  readonly icon: typeof Bell;
  readonly color: string;
}[] = [
  { key: 'sendPush', label: 'Push', icon: Smartphone, color: 'text-sky-600 bg-sky-500/10' },
  { key: 'sendEmail', label: 'Email', icon: Mail, color: 'text-amber-600 bg-amber-500/10' },
  {
    key: 'includeInOrgAudit',
    label: 'Audit trail',
    icon: Bell,
    color: 'text-violet-600 bg-violet-500/10',
  },
];

export function BroadcastTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const [orgQuery, setOrgQuery] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<{
    orgId: OrgId;
    name: string;
    slug: string;
  } | null>(null);
  const [target, setTarget] = useState<AudienceTarget>('all');
  const [membershipRole, setMembershipRole] = useState<MembershipRole>('member');
  const [selectedUserIds, setSelectedUserIds] = useState<readonly string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sendPush, setSendPush] = useState(true);
  const [sendEmail, setSendEmail] = useState(false);
  const [includeInOrgAudit, setIncludeInOrgAudit] = useState(true);
  const [sent, setSent] = useState<{ recipientCount: number } | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(true);

  const orgId = selectedOrg?.orgId ?? null;

  /* The picker reuses the SAME `orgs.list` page the console header's own
     stat cards fetch (`keys.platformOrgs(null)`, limit 100) — same query
     key, so React Query dedupes rather than firing a second request. It is
     still a client-side filter over one page, not a real directory search
     (`orgs.list` takes a cursor, no search term) — identical in kind to the
     Organizations tab's own `TableSearch`, just embedded in a form instead
     of a full table. */
  const orgsList = useQuery({
    queryKey: keys.platformOrgs(null),
    queryFn: async () =>
      wire(await api.platformAdmin.orgs.list.query({ cursor: null, limit: 100 })),
  });

  const orgMatches = (() => {
    const q = orgQuery.trim().toLowerCase();
    if (q === '') return [];
    return (orgsList.data?.orgs ?? [])
      .filter(
        (candidate) =>
          candidate.name.toLowerCase().includes(q) ||
          candidate.slug.toLowerCase().includes(q) ||
          candidate.ownerEmail?.toLowerCase().includes(q) === true,
      )
      .slice(0, 8);
  })();

  const org = useQuery({
    queryKey: keys.platformOrgLookup(orgId ?? ''),
    queryFn: async () => {
      if (orgId === null) throw new Error('No org selected.');
      return wire(await api.platformAdmin.orgs.detail.query({ orgId }));
    },
    enabled: orgId !== null,
    retry: false,
  });

  /* Only an ACTIVE member can be a 'users' target — `resolveAudience` on the
     server refuses one that resolves to nobody, so filtering here is a UX
     courtesy, not the real gate; the server still re-checks. */
  const activeMembers = (org.data?.members ?? []).filter((member) => member.status === 'active');
  const pushCapableCount = activeMembers.filter((m) => m.hasPushDevice).length;

  const membershipRoleForPreview = target === 'role' ? membershipRole : null;
  const userIdsForPreview = target === 'users' ? selectedUserIds : [];

  const preview = useQuery({
    queryKey: keys.platformBroadcastPreview(
      orgId ?? '',
      target,
      membershipRoleForPreview,
      userIdsForPreview,
    ),
    queryFn: async () => {
      if (orgId === null) throw new Error('No org selected.');
      return wire(
        await api.platformAdmin.broadcast.previewAudience.query({
          orgId,
          target,
          ...(target === 'role' ? { membershipRole } : {}),
          ...(target === 'users' && selectedUserIds.length > 0
            ? { userIds: [...selectedUserIds] }
            : {}),
        }),
      );
    },
    enabled:
      orgId !== null &&
      org.data !== undefined &&
      (target !== 'users' || selectedUserIds.length > 0),
    retry: false,
  });

  const history = useQuery({
    queryKey: keys.platformBroadcastHistory(orgId ?? ''),
    queryFn: async () => {
      if (orgId === null) throw new Error('No org selected.');
      return wire(await api.platformAdmin.broadcast.history.query({ orgId, limit: 10 }));
    },
    enabled: orgId !== null && org.data !== undefined,
  });

  const send = useMutation({
    mutationFn: () => {
      if (orgId === null) throw new Error('No org selected.');
      return api.platformAdmin.broadcast.send.mutate({
        audience: {
          orgId,
          target,
          ...(target === 'role' ? { membershipRole } : {}),
          ...(target === 'users' ? { userIds: [...selectedUserIds] } : {}),
        },
        subject: subject.trim(),
        body: body.trim(),
        sendPush,
        sendEmail,
        includeInOrgAudit,
      });
    },
    onSuccess: async (result) => {
      setSent({ recipientCount: result.recipientCount });
      setSubject('');
      setBody('');
      await Promise.all([history.refetch(), preview.refetch()]);
    },
    onError: (error) => {
      guard(error, () => {
        send.mutate();
      });
    },
  });

  /* Sends a PAST broadcast again — its own subject, body, audience and
     channels, replayed server-side against the CURRENT membership (see
     broadcast.service.ts's own header on why a resend is a fresh send, not
     a retry of the original delivery rows). */
  const resend = useMutation({
    mutationFn: (broadcastId: string) => api.platformAdmin.broadcast.resend.mutate({ broadcastId }),
    onSuccess: async () => {
      await Promise.all([history.refetch(), preview.refetch()]);
    },
    onError: (error, broadcastId) => {
      guard(error, () => {
        resend.mutate(broadcastId);
      });
    },
  });

  /* `stepUp: true` is baked into every `platformRoute` in this router — the
     same 5-minute freshness window every other tab on this page runs under
     (`apps/api/src/trpc/builder.ts`'s `STEP_UP_MAX_AGE_MS`). There is no
     per-tab flag to set: `orgs.list`, `orgs.detail` and every `broadcast.*`
     route all resolve through the identical `platformRoute` builder, so
     checking either query's error code below is enough to catch it. */
  if (
    errorCodeOf(org.error) === 'STEP_UP_REQUIRED' ||
    errorCodeOf(orgsList.error) === 'STEP_UP_REQUIRED'
  ) {
    return <StepUpGate onStepUp={onStepUp} />;
  }

  const canPreview = orgId !== null && (target !== 'users' || selectedUserIds.length > 0);
  const canSend =
    canPreview &&
    preview.data !== undefined &&
    !preview.isFetching &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    (sendPush || sendEmail) &&
    !send.isPending;

  const activeChannelCount = (sendPush ? 1 : 0) + (sendEmail ? 1 : 0) + (includeInOrgAudit ? 1 : 0);

  return (
    <section aria-label="Broadcast" className="flex flex-col gap-5">
      {/* ---- header ---- */}
      <div>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Send a message to a specific member, a role-filtered subset, or every active member of ONE
          org — never across orgs in a single send. In-app delivery is always on; push and email are
          each optional. This does not reach an open tab instantly the way an ordinary notification
          does — it appears on next load or poll, and push/email deliver on their own schedule.
        </p>
      </div>

      {/* ---- org selector ---- */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <Field
          label="Organization"
          htmlFor="broadcast-org-search"
          hint="Search by name, slug, or owner email."
        >
          {selectedOrg === null ? (
            <>
              <TableSearch
                value={orgQuery}
                onChange={setOrgQuery}
                placeholder="Search organizations…"
              />
              {orgsList.isPending && (
                <p className="mt-1.5 text-xs text-ink-faint">Loading organizations…</p>
              )}
              {orgsList.isError && (
                <ErrorView error={orgsList.error} title="Could not load organizations" />
              )}
              {orgQuery.trim() !== '' && orgsList.data !== undefined && orgMatches.length === 0 && (
                <p className="mt-1.5 text-xs text-ink-faint">
                  No organization matches &ldquo;{orgQuery.trim()}&rdquo;.
                </p>
              )}
              {orgMatches.length > 0 && (
                <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {orgMatches.map((candidate) => (
                    <li key={candidate.orgId}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover/50"
                        onClick={() => {
                          setSelectedOrg({
                            orgId: candidate.orgId as OrgId,
                            name: candidate.name,
                            slug: candidate.slug,
                          });
                          setOrgQuery('');
                          setTarget('all');
                          setSelectedUserIds([]);
                          setSent(null);
                        }}
                      >
                        <span className="min-w-0 truncate text-ink">
                          {candidate.name}{' '}
                          <span className="text-ink-faint">({candidate.slug})</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-faint">
                          {candidate.memberCount} members
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-line/50 bg-surface-sunken px-3 py-2.5 text-sm">
              <Users
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-muted"
                strokeWidth={1.8}
              />
              <span className="min-w-0 flex-1 truncate text-ink">
                {selectedOrg.name} <span className="text-ink-faint">({selectedOrg.slug})</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setSelectedOrg(null);
                  setTarget('all');
                  setSelectedUserIds([]);
                  setSent(null);
                }}
              >
                Change
              </Button>
            </div>
          )}
        </Field>
      </div>

      {org.isFetching && <p className="text-xs text-ink-faint">Loading org…</p>}
      {org.isError && <ErrorView error={org.error} title="Could not load that organization" />}

      {org.data !== undefined && (
        <>
          {/* ---- summary stats ---- */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard icon={Users} label="Org members" value={org.data.memberCount} />
            <StatCard
              icon={Smartphone}
              label="Push-capable"
              value={`${String(pushCapableCount)} of ${String(activeMembers.length)}`}
            />
            <StatCard
              icon={Send}
              label="Last broadcast"
              value={
                history.data !== undefined &&
                history.data.length > 0 &&
                history.data[0] !== undefined
                  ? `${String(history.data[0].recipientCount)} recipients`
                  : 'None yet'
              }
            />
          </div>

          {/* ---- compose form ---- */}
          <div className="rounded-xl border border-line bg-surface-raised p-5">
            <div className="mb-4 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <Send aria-hidden="true" className="size-3.5" strokeWidth={2} />
              </span>
              <h3 className="text-[13px] font-semibold text-ink">Compose broadcast</h3>
            </div>

            {/* ---- audience ---- */}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-ink-muted">Audience</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {AUDIENCE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-all',
                      target === option.value
                        ? 'border-accent/40 bg-accent/6 text-ink shadow-sm'
                        : 'border-line/50 bg-surface-sunken text-ink-muted hover:border-line hover:bg-surface-hover/30',
                    )}
                  >
                    <input
                      type="radio"
                      name="broadcast-target"
                      checked={target === option.value}
                      onChange={() => {
                        setTarget(option.value);
                        setSelectedUserIds([]);
                      }}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                        target === option.value
                          ? 'border-accent bg-accent'
                          : 'border-line bg-surface',
                      )}
                    >
                      {target === option.value && <span className="size-2 rounded-full bg-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{option.label}</span>
                      <span className="block text-[11px] text-ink-faint">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {target === 'role' && (
              <div className="mb-4">
                <Field label="Role" htmlFor="broadcast-role">
                  <div className="flex flex-wrap gap-1.5">
                    {ROLE_OPTIONS.map((role) => (
                      <button
                        key={role.value}
                        type="button"
                        onClick={() => {
                          setMembershipRole(role.value);
                        }}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                          membershipRole === role.value
                            ? 'border-accent/40 bg-accent/10 text-accent shadow-sm'
                            : 'border-line/50 bg-surface-sunken text-ink-muted hover:border-line hover:text-ink',
                        )}
                      >
                        {role.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            )}

            {target === 'users' && (
              <fieldset className="mb-4">
                <legend className="mb-1.5 text-xs font-medium text-ink-muted">Members</legend>
                {activeMembers.length === 0 ? (
                  <p className="text-xs text-ink-faint">
                    This org has no active members to target.
                  </p>
                ) : (
                  <>
                    <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line/50">
                      {activeMembers.map((member) => (
                        <label
                          key={member.userId}
                          className={cn(
                            'flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-surface-hover/30',
                            member.hasPushDevice ? 'text-ink' : 'text-ink-faint',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selectedUserIds.includes(member.userId)}
                            onChange={() => {
                              setSelectedUserIds((prev) =>
                                prev.includes(member.userId)
                                  ? prev.filter((id) => id !== member.userId)
                                  : [...prev, member.userId],
                              );
                            }}
                            className="sr-only"
                          />
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                              selectedUserIds.includes(member.userId)
                                ? 'border-accent bg-accent text-white'
                                : 'border-line bg-surface',
                            )}
                          >
                            {selectedUserIds.includes(member.userId) && (
                              <CheckCircle2 className="size-3" strokeWidth={2.5} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {member.name !== null
                              ? `${member.name} — ${member.email}`
                              : member.email}
                          </span>
                          {!member.hasPushDevice && (
                            <Badge
                              className="shrink-0"
                              title="No push device is registered for this person — a push notification will not reach them, though in-app and email still will."
                            >
                              No push device
                            </Badge>
                          )}
                        </label>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      {selectedUserIds.length} of {activeMembers.length} selected.
                    </p>
                  </>
                )}
              </fieldset>
            )}

            {/* ---- subject & body ---- */}
            <div className="mb-4">
              <Field label="Subject" htmlFor="broadcast-subject">
                <Input
                  id="broadcast-subject"
                  value={subject}
                  onChange={(event) => {
                    setSubject(event.target.value);
                  }}
                  maxLength={120}
                  placeholder="Scheduled maintenance this weekend"
                />
              </Field>
              <p className="mt-1 text-right text-[11px] text-ink-faint tabular-nums">
                {subject.length}/120
              </p>
            </div>

            <div className="mb-4">
              <Field label="Message" htmlFor="broadcast-body">
                <Textarea
                  id="broadcast-body"
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                  }}
                  maxLength={2000}
                  rows={4}
                  placeholder="Plain text only — this becomes a push notification and an email, neither of which renders rich text."
                />
              </Field>
              <p className="mt-1 text-right text-[11px] text-ink-faint tabular-nums">
                {body.length}/2000
              </p>
            </div>

            {/* ---- delivery channels ---- */}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-ink-muted">Delivery channels</p>
              <div className="flex flex-wrap gap-2">
                {CHANNEL_META.map((channel) => {
                  const enabled =
                    channel.key === 'sendPush'
                      ? sendPush
                      : channel.key === 'sendEmail'
                        ? sendEmail
                        : includeInOrgAudit;
                  const Icon = channel.icon;
                  return (
                    <button
                      key={channel.key}
                      type="button"
                      onClick={() => {
                        if (channel.key === 'sendPush') setSendPush((p) => !p);
                        else if (channel.key === 'sendEmail') setSendEmail((p) => !p);
                        else setIncludeInOrgAudit((p) => !p);
                      }}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                        enabled
                          ? `${channel.color} border-current/20 shadow-sm`
                          : 'border-line/50 bg-surface-sunken text-ink-faint hover:border-line hover:text-ink-muted',
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2} />
                      {channel.label}
                    </button>
                  );
                })}
              </div>
              {activeChannelCount === 0 && (
                <p className="mt-1.5 text-[11px] text-danger">
                  At least one delivery channel must be enabled.
                </p>
              )}
            </div>

            {/* ---- preview & send ---- */}
            <div className="flex items-center gap-3 border-t border-line pt-4">
              <Button
                variant="secondary"
                disabled={!canPreview || preview.isFetching}
                onClick={() => {
                  void preview.refetch();
                }}
              >
                {preview.isFetching ? 'Counting…' : 'Preview audience'}
              </Button>

              {preview.isError && (
                <ErrorView error={preview.error} title="Could not resolve audience" />
              )}
              {preview.data !== undefined && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Radio aria-hidden="true" className="size-3.5 text-ink-faint" strokeWidth={2} />
                  <span className="text-ink-muted">
                    Will reach{' '}
                    <span className="font-semibold text-ink">{String(preview.data.count)}</span>{' '}
                    {preview.data.count === 1 ? 'person' : 'people'}
                  </span>
                </div>
              )}
            </div>

            {preview.data !== undefined && (
              <div className="mt-3">
                <ConfirmButton
                  label={`Send to ${String(preview.data.count)} ${preview.data.count === 1 ? 'person' : 'people'}`}
                  confirmLabel="Confirm send"
                  disabled={!canSend}
                  onConfirm={() => {
                    send.mutate();
                  }}
                />
                {send.isError && <ErrorView error={send.error} title="Send failed" />}
              </div>
            )}

            {sent !== null && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                Sent to {sent.recipientCount} {sent.recipientCount === 1 ? 'person' : 'people'}.
              </div>
            )}
          </div>

          {/* ---- recent broadcasts ---- */}
          <div className="rounded-xl border border-line bg-surface-raised">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left"
              onClick={() => {
                setHistoryExpanded((p) => !p);
              }}
            >
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Recent broadcasts</h3>
                {history.data !== undefined && history.data.length > 0 && (
                  <Badge>{String(history.data.length)}</Badge>
                )}
              </div>
              {historyExpanded ? (
                <ChevronUp className="size-4 text-ink-faint" strokeWidth={2} />
              ) : (
                <ChevronDown className="size-4 text-ink-faint" strokeWidth={2} />
              )}
            </button>

            {historyExpanded && (
              <div className="border-t border-line px-4 pb-4 pt-3">
                {history.isPending && <SkeletonRows rows={2} className="*:h-8" />}
                {history.data?.length === 0 && (
                  <p className="text-xs text-ink-faint">No broadcasts sent to this org yet.</p>
                )}
                {history.data !== undefined && history.data.length > 0 && (
                  <ul className="space-y-2">
                    {history.data.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center gap-3 rounded-lg border border-line/50 bg-surface-sunken px-3 py-2.5 transition-colors hover:border-line"
                      >
                        <span
                          className={cn(
                            'flex size-7 shrink-0 items-center justify-center rounded-lg',
                            entry.audienceTarget === 'all'
                              ? 'bg-sky-500/10 text-sky-600'
                              : entry.audienceTarget === 'role'
                                ? 'bg-amber-500/10 text-amber-600'
                                : 'bg-violet-500/10 text-violet-600',
                          )}
                        >
                          <Send aria-hidden="true" className="size-3.5" strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">{entry.subject}</p>
                          <p className="text-[11px] text-ink-faint">
                            {entry.recipientCount}{' '}
                            {entry.recipientCount === 1 ? 'recipient' : ' recipients'} ·{' '}
                            {formatDateTime(entry.createdAt)}
                          </p>
                        </div>
                        <ConfirmButton
                          label="Resend"
                          confirmLabel="Send again"
                          size="sm"
                          disabled={resend.isPending}
                          onConfirm={() => {
                            resend.mutate(entry.id);
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {resend.isError && <ErrorView error={resend.error} title="Resend failed" />}
                {resend.isSuccess && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2 aria-hidden="true" className="size-3.5" strokeWidth={2} />
                    Resent to {resend.data.recipientCount}{' '}
                    {resend.data.recipientCount === 1 ? 'person' : 'people'}.
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
