import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
import { StepUpGate, TableSearch } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Broadcast — a message to a specific member, a role-filtered subset, or
 * every active member of one org (migration 0083). No "every org" audience
 * exists anywhere in this form on purpose — see broadcast.service.ts's own
 * header on why the blast radius stays capped at one tenant per send.
 * -------------------------------------------------------------------------- */

type AudienceTarget = 'all' | 'role' | 'users';
type MembershipRole = 'owner' | 'admin' | 'member' | 'guest';

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

  return (
    <section aria-label="Broadcast">
      <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
        Send a message to a specific member, a role-filtered subset, or every active member of ONE
        org — never across orgs in a single send. In-app delivery is always on; push and email are
        each optional. This does not reach an open tab instantly the way an ordinary notification
        does — it appears on next load or poll, and push/email deliver on their own schedule.
      </p>

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
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover/50"
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
                        {candidate.name} <span className="text-ink-faint">({candidate.slug})</span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {candidate.memberCount} members
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-line/50 bg-surface-sunken px-3 py-2 text-sm">
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

      {org.isFetching && <p className="mt-1 text-xs text-ink-faint">Loading org…</p>}
      {org.isError && <ErrorView error={org.error} title="Could not load that organization" />}

      {org.data !== undefined && (
        <div className="mt-4 space-y-4 rounded-xl border border-line p-4">
          <p className="text-sm font-medium text-ink">
            {org.data.name} <span className="text-ink-faint">({org.data.memberCount} members)</span>
          </p>

          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-ink-muted">Audience</legend>
            <div className="flex flex-wrap gap-3">
              {(
                [
                  ['all', 'Every active member'],
                  ['role', 'Members with a role'],
                  ['users', 'Specific members'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="radio"
                    name="broadcast-target"
                    checked={target === value}
                    onChange={() => {
                      setTarget(value);
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {target === 'role' && (
            <Field label="Role" htmlFor="broadcast-role">
              <select
                id="broadcast-role"
                value={membershipRole}
                onChange={(event) => {
                  setMembershipRole(event.target.value as MembershipRole);
                }}
                className="w-full rounded-lg border border-line/50 bg-surface-sunken px-3 py-2 text-sm text-ink"
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="guest">Guest</option>
              </select>
            </Field>
          )}

          {target === 'users' && (
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-ink-muted">Members</legend>
              {activeMembers.length === 0 ? (
                <p className="text-xs text-ink-faint">This org has no active members to target.</p>
              ) : (
                <>
                  <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line/50">
                    {activeMembers.map((member) => (
                      <label
                        key={member.userId}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-surface-hover/30',
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
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {member.name !== null ? `${member.name} — ${member.email}` : member.email}
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

          <div className="flex flex-wrap gap-4 text-sm text-ink">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={sendPush}
                onChange={(event) => {
                  setSendPush(event.target.checked);
                }}
              />
              Push notification
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(event) => {
                  setSendEmail(event.target.checked);
                }}
              />
              Email
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={includeInOrgAudit}
                onChange={(event) => {
                  setIncludeInOrgAudit(event.target.checked);
                }}
              />
              Show in this org's own audit trail
            </label>
          </div>

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
              <p className="text-sm text-ink-muted">
                Will reach <span className="font-medium text-ink">{preview.data.count}</span>{' '}
                {preview.data.count === 1 ? 'person' : 'people'}.
              </p>
            )}
          </div>

          {preview.data !== undefined && (
            <div>
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
            <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              Sent to {sent.recipientCount} {sent.recipientCount === 1 ? 'person' : 'people'}.
            </p>
          )}

          <div className="border-t border-line pt-4">
            <p className="mb-2 text-xs font-medium text-ink-muted">Recent broadcasts to this org</p>
            {history.isPending && <SkeletonRows rows={2} className="*:h-8" />}
            {history.data?.length === 0 && <p className="text-xs text-ink-faint">None sent yet.</p>}
            {history.data !== undefined && history.data.length > 0 && (
              <ul className="space-y-1.5">
                {history.data.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-ink">{entry.subject}</span>
                    <span className="shrink-0 text-ink-faint">
                      {entry.recipientCount} · {formatDateTime(entry.createdAt)}
                    </span>
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
              <p className="mt-1.5 text-xs text-success">
                Resent to {resend.data.recipientCount}{' '}
                {resend.data.recipientCount === 1 ? 'person' : 'people'}.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
