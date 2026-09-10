import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import type { OrgId } from '@taskflow/contracts';
import { Building2, Search, ShieldAlert } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Field,
  Input,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  MemberBar,
  OrgDetailDialog,
  Pagination,
  RowActionsMenu,
  StepUpGate,
  TableSearch,
  downloadCsv,
  money,
  relativeTime,
} from './shared.js';

/* -------------------------------------------------------------------------- *
 * Organizations
 * -------------------------------------------------------------------------- */

export function OrgsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');

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

  /* Moving an org between plans. Its own dialog rather than an inline select,
     because the route requires a REASON — moving a tenant off what they signed
     up for is a support decision, and a decision with no recorded reason is one
     nobody can review later. */
  const [planTarget, setPlanTarget] = useState<{
    orgId: string;
    name: string;
    planId: string | null;
  } | null>(null);

  /** The drill-down panel's subject, or null when it is closed. */
  const [detailOrgId, setDetailOrgId] = useState<string | null>(null);

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

  const filteredOrgs = orgs.data?.orgs.filter((org) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      org.name.toLowerCase().includes(q) ||
      org.slug.toLowerCase().includes(q) ||
      org.ownerEmail?.toLowerCase().includes(q) === true ||
      org.ownerName?.toLowerCase().includes(q) === true
    );
  });

  return (
    <section aria-label="Organizations">
      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter orgs by name, slug, or owner…"
        />
        {orgs.data !== undefined && orgs.data.orgs.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'Organization',
                'Slug',
                'Owner name',
                'Owner email',
                'Plan',
                'Billing status',
                'Trial ends',
                'Grace ends',
                'Renews',
                'Last invoice status',
                'Last invoice amount',
                'Last invoice date',
                'Status',
                'Members',
                'Created',
              ];
              const rows = [
                header,
                ...orgs.data.orgs.map((org) => [
                  org.name,
                  org.slug,
                  org.ownerName ?? '',
                  org.ownerEmail ?? '',
                  org.planId ?? '',
                  org.billingStatus,
                  org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                  org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                  org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                  org.lastInvoice?.status ?? '',
                  org.lastInvoice !== null
                    ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                    : '',
                  org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                  org.status,
                  String(org.memberCount),
                  formatDate(org.createdAt),
                ]),
              ];
              downloadCsv(`orgs-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {orgs.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {orgs.isError && <ErrorView error={orgs.error} title="Could not load organizations" />}

      {orgs.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Organization
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Owner
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Plan
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Renews
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Last invoice
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Members
                </th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Created
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {(filteredOrgs ?? []).map((org) => (
                <tr
                  key={org.orgId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setDetailOrgId(org.orgId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-ink transition-colors group-hover:text-accent">
                      {org.name}
                    </p>
                    <p className="font-mono text-xs text-ink-faint">{org.slug}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    {org.ownerEmail === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        {org.ownerName !== null && <p className="text-ink">{org.ownerName}</p>}
                        <p className="text-xs text-ink-muted">{org.ownerEmail}</p>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-ink">
                      {org.planId ?? <span className="text-ink-faint">no plan</span>}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {org.billingStatus}
                      {org.billingStatus === 'trialing' &&
                        org.trialEndsAt !== null &&
                        ` — ends ${formatDate(org.trialEndsAt)}`}
                      {org.billingStatus === 'past_due' &&
                        org.billingGraceEndsAt !== null &&
                        ` — grace ends ${formatDate(org.billingGraceEndsAt)}`}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.currentPeriodEnd === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <span>
                        {formatDate(org.currentPeriodEnd)}
                        <span className="ml-1.5 text-xs text-ink-faint">
                          {relativeTime(new Date(org.currentPeriodEnd))}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {org.lastInvoice === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        <p
                          className={
                            org.lastInvoice.status === 'paid' ? 'text-success' : 'text-danger'
                          }
                        >
                          {org.lastInvoice.status}{' '}
                          {money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)}
                        </p>
                        <p className="text-xs text-ink-faint">
                          {formatDate(org.lastInvoice.issuedAt)}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={org.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <MemberBar count={org.memberCount} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {formatDate(org.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          setPlanTarget({
                            orgId: org.orgId,
                            name: org.name,
                            planId: org.planId,
                          });
                        }}
                      >
                        Plan
                      </Button>
                      {org.status === 'suspended' ? (
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
                      {org.status === 'suspended' && (
                        <RowActionsMenu>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger/10"
                            disabled={remove.isPending}
                            onClick={() => {
                              setConfirmSlug('');
                              setDeleteTarget({ orgId: org.orgId, name: org.name, slug: org.slug });
                            }}
                          >
                            <ShieldAlert className="size-3" strokeWidth={2.5} />
                            Delete org
                          </button>
                        </RowActionsMenu>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {(filteredOrgs ?? []).length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">
                          No organizations match your search.
                        </p>
                        <p className="text-xs text-ink-faint">
                          Try a different name, slug, or owner email.
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Building2 className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No organizations yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Organizations are created when users sign up. Once the first user joins,
                          their org will appear here.
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

      {(suspend.isError || reactivate.isError || remove.isError) && (
        <ErrorView
          error={suspend.error ?? reactivate.error ?? remove.error}
          title="Could not change the status"
        />
      )}

      {detailOrgId !== null && (
        <OrgDetailDialog
          orgId={detailOrgId}
          guard={guard}
          onClose={() => {
            setDetailOrgId(null);
          }}
        />
      )}

      {planTarget !== null && (
        <ChangeOrgPlanDialog
          guard={guard}
          org={planTarget}
          onClose={() => {
            setPlanTarget(null);
          }}
          onChanged={() => {
            setPlanTarget(null);
            void queryClient.invalidateQueries({ queryKey: ['platform'] });
          }}
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
              <code className="rounded bg-surface-sunken px-1 font-mono text-xs">
                {deleteTarget.slug}
              </code>{' '}
              to confirm.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmSlug === deleteTarget.slug) {
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
      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (orgs.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(orgs.data?.nextCursor ?? null);
          }}
          {...(filteredOrgs !== undefined
            ? {
                countLabel: `${String(filteredOrgs.length)} organization${filteredOrgs.length === 1 ? '' : 's'}`,
              }
            : {})}
        />
      </div>
    </section>
  );
}

/** The one column in the org directory that has meaning beyond itself. */
function StatusBadge({ status }: { readonly status: string }) {
  if (status === 'suspended') {
    return (
      <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <ShieldAlert className="size-3" strokeWidth={2.5} />
        suspended
      </span>
    );
  }
  if (status === 'deleted') {
    return (
      <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-faint">
        deleted
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-success" />
      active
    </span>
  );
}

/**
 * Moves one org onto a plan.
 *
 * Two things this dialog has to say out loud, because both are behaviours an
 * operator will otherwise assume wrongly in one direction or the other:
 *
 * - **It does not change what they are charged.** The route writes `plan_id`
 *   and nothing else — not `billing_status`, not the subscription. Moving a
 *   paying org to a cheaper plan here grants the cheaper plan's entitlements
 *   and leaves their next invoice exactly as it was. That is the honest
 *   behaviour for an operator override ("give this customer Business while we
 *   sort out their contract"), and anything that silently repriced a live
 *   subscription from a console dropdown would be worse.
 * - **A reason is required.** Not decoration: it lands in the hash-chained
 *   operator audit log, and it is the only thing that makes the change
 *   reviewable later.
 */
function ChangeOrgPlanDialog({
  guard,
  org,
  onClose,
  onChanged,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly org: { readonly orgId: string; readonly name: string; readonly planId: string | null };
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [planId, setPlanId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const plans = useQuery({
    queryKey: keys.platformPlans(),
    queryFn: async () => wire(await api.platformAdmin.plans.list.query(undefined)),
  });

  const change = useMutation({
    mutationFn: (input: { orgId: OrgId; planId: string; reason: string }) =>
      api.platformAdmin.plans.setOrgPlan.mutate(input),
    onSuccess: onChanged,
    onError: (error, input) => {
      guard(error, () => {
        change.mutate(input);
      });
    },
  });

  /* Retired plans are omitted: an org already on one keeps it, but moving a
     NEW org onto a tier that is no longer sold or priced is how a plan nobody
     can renew acquires customers. The server refuses it too. */
  const selectable = (plans.data ?? []).filter((plan) => plan.isActive);
  const chosen = planId ?? org.planId;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent size="sm" className="p-4">
        <ModalTitle>{org.name} plan</ModalTitle>
        <ModalDescription>
          Currently <strong>{org.planId ?? 'no plan'}</strong>. This changes what the org is
          entitled to — it does <strong>not</strong> change their subscription or what they are
          charged.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {plans.isPending && <SkeletonRows rows={3} className="*:h-8" />}
          {plans.isError && <ErrorView error={plans.error} title="Could not load plans" />}

          {plans.data !== undefined && (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
              {selectable.map((plan) => (
                <li key={plan.id} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      id={`org-plan-${plan.id}`}
                      name="org-plan"
                      className="mt-0.5"
                      checked={chosen === plan.id}
                      onChange={() => {
                        setPlanId(plan.id);
                      }}
                    />
                    <label
                      htmlFor={`org-plan-${plan.id}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-sm text-ink">
                        {plan.name}
                        {plan.isDefault && <Badge>default</Badge>}
                      </span>
                      <span className="block text-xs text-ink-muted">
                        {plan.features.length === 0 ? 'core only' : plan.features.join(', ')}
                      </span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Field label="Reason" htmlFor="org-plan-reason">
            <Input
              id="org-plan-reason"
              value={reason}
              placeholder="Contract negotiated — Business until renewal"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="mt-0.5 text-xs text-ink-faint">
              Recorded in the operator audit chain. Required.
            </p>
          </Field>

          {change.isError && <ErrorView error={change.error} title="Could not change the plan" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                change.isPending || reason.trim() === '' || chosen === null || chosen === org.planId
              }
              onClick={() => {
                if (chosen === null) return;
                change.mutate({
                  orgId: org.orgId as OrgId,
                  planId: chosen,
                  reason: reason.trim(),
                });
              }}
            >
              {change.isPending ? <Spinner /> : 'Change plan'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}
