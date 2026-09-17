import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import {
  Layers,
  Package,
  Search,
  ShieldAlert,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { LIMIT_COPY, featureDescription, featureLabel } from '../../lib/feature-labels.js';
import { StepUpGate, StatCard, TableSearch, ceiling, money } from './shared.js';

/**
 * Palette of visually distinct color tokens. Each entry is a complete set
 * (bar, price, dot, chipBg, chipText) that works on the dark card background.
 * The palette is fixed — adding a new plan tier never requires a code change;
 * `tierAccent` picks from here deterministically based on a hash of the plan id.
 */
const PALETTE: readonly ({
  readonly bar: string;
  readonly price: string;
  readonly dot: string;
  readonly chipBg: string;
  readonly chipText: string;
})[] = [
  /* sky     */ { bar: 'bg-sky-500/60',     price: 'text-sky-400',     dot: 'bg-sky-400',     chipBg: 'bg-sky-500/10',     chipText: 'text-sky-400' },
  /* teal    */ { bar: 'bg-teal-500/60',    price: 'text-teal-400',    dot: 'bg-teal-400',    chipBg: 'bg-teal-500/10',    chipText: 'text-teal-400' },
  /* accent  */ { bar: 'bg-accent/60',      price: 'text-accent',      dot: 'bg-accent',      chipBg: 'bg-accent/10',      chipText: 'text-accent' },
  /* amber   */ { bar: 'bg-amber-500/60',   price: 'text-amber-400',   dot: 'bg-amber-400',   chipBg: 'bg-amber-500/10',   chipText: 'text-amber-400' },
  /* violet  */ { bar: 'bg-violet-500/60',  price: 'text-violet-400',  dot: 'bg-violet-400',  chipBg: 'bg-violet-500/10',  chipText: 'text-violet-400' },
  /* rose    */ { bar: 'bg-rose-500/60',    price: 'text-rose-400',    dot: 'bg-rose-400',    chipBg: 'bg-rose-500/10',    chipText: 'text-rose-400' },
  /* emerald */ { bar: 'bg-emerald-500/60', price: 'text-emerald-400', dot: 'bg-emerald-400', chipBg: 'bg-emerald-500/10', chipText: 'text-emerald-400' },
  /* orange  */ { bar: 'bg-orange-500/60',  price: 'text-orange-400',  dot: 'bg-orange-400',  chipBg: 'bg-orange-500/10',  chipText: 'text-orange-400' },
  /* fuchsia */ { bar: 'bg-fuchsia-500/60', price: 'text-fuchsia-400', dot: 'bg-fuchsia-400', chipBg: 'bg-fuchsia-500/10', chipText: 'text-fuchsia-400' },
  /* cyan    */ { bar: 'bg-cyan-500/60',    price: 'text-cyan-400',    dot: 'bg-cyan-400',    chipBg: 'bg-cyan-500/10',    chipText: 'text-cyan-400' },
];

/** djb2 — simple string hash that distributes well over lowercase plan ids. */
function hashId(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Deterministic visual identity for plan cards. Any plan id — including ones
 * the operator creates at runtime — gets a stable, distinct color from a fixed
 * palette without a code change.
 */
function tierAccent(planId: string): (typeof PALETTE)[number] {
  const idx = hashId(planId) % PALETTE.length;
  const entry = PALETTE[idx];
  if (entry === undefined) {
    // PALETTE is non-empty and idx < length — this branch is unreachable.
    return { bar: 'bg-accent/40', price: 'text-ink', dot: 'bg-accent', chipBg: 'bg-accent/10', chipText: 'text-accent' };
  }
  return entry;
}

/**
 * The plan catalog — the tab that replaces opening the Stripe dashboard.
 *
 * Two things here are deliberate rather than incidental:
 *
 * - **Repricing states its consequence before it happens.** Stripe Prices are
 *   immutable, so changing an amount archives the old Price and creates a new
 *   one, and every existing subscriber stays on what they are paying. A console
 *   that hides which button charges real customers is a console that will
 *   eventually charge them by accident, so the form says how many orgs are on
 *   the plan and that they will not move.
 * - **Retired plans are shown, not filtered.** A tier that is no longer sold
 *   still has tenants on it. Hiding it would make "why is this org on a plan I
 *   cannot see" the first question this page cannot answer.
 */
/** Convert a display name into a safe plan id: lowercase, spaces to hyphens, strip non-alphanumeric. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function PlansTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [pricing, setPricing] = useState<string | null>(null);
  const [editingFeatures, setEditingFeatures] = useState<string | null>(null);
  const [editingLimits, setEditingLimits] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [retireTarget, setRetireTarget] = useState<{
    planId: string;
    name: string;
    orgCount: number;
    features: readonly string[];
  } | null>(null);

  const plans = useQuery({
    queryKey: keys.platformPlans(),
    queryFn: async () => wire(await api.platformAdmin.plans.list.query(undefined)),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.platformPlans() });
  };

  const archive = useMutation({
    mutationFn: (input: { planId: string }) => api.platformAdmin.plans.archive.mutate(input),
    onSuccess: invalidate,
    onError: (error, input) => {
      guard(error, () => {
        archive.mutate(input);
      });
    },
  });

  const setDefault = useMutation({
    mutationFn: (input: { planId: string }) => api.platformAdmin.plans.setDefault.mutate(input),
    onSuccess: invalidate,
    onError: (error, input) => {
      guard(error, () => {
        setDefault.mutate(input);
      });
    },
  });

  if (errorCodeOf(plans.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredPlans = plans.data?.filter((plan) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      plan.name.toLowerCase().includes(q) ||
      plan.id.toLowerCase().includes(q) ||
      plan.description?.toLowerCase().includes(q) === true ||
      plan.features.some((feature) => feature.toLowerCase().includes(q))
    );
  });

  /* Summary stats — computed from the full plan list. */
  const allPlans = plans.data ?? [];
  const activePlans = allPlans.filter((p) => p.isActive);
  const retiredPlans = allPlans.filter((p) => !p.isActive);
  const totalOrgsOnPaid = allPlans
    .filter((p) => p.isActive && p.currentPrices.some((pr) => pr.amountCents > 0))
    .reduce((sum, p) => sum + p.orgCount, 0);
  let totalMrr = 0;
  for (const plan of allPlans) {
    if (!plan.isActive) continue;
    const price = plan.currentPrices.find((pr) => pr.interval === 'month');
    if (price !== undefined && price.amountCents > 0) {
      totalMrr += price.amountCents * plan.orgCount;
    }
  }

  return (
    <section aria-label="Plans" className="space-y-4">
      {/* ── Summary stat cards ── */}
      {allPlans.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard icon={Layers} label="Total plans" value={allPlans.length} accent />
          <StatCard icon={Package} label="Active" value={activePlans.length} />
          <StatCard icon={XCircle} label="Retired" value={retiredPlans.length} />
          <StatCard icon={Users} label="Orgs on paid" value={totalOrgsOnPaid} />
          <StatCard icon={TrendingUp} label="MRR (all plans)" value={money(totalMrr, 'usd')} />
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-xs text-ink-muted">
          What tenants may buy. Creating or repricing a plan writes to the payment processor
          directly — the processor&apos;s own dashboard is never needed. Prices are immutable there,
          so changing an amount retires the old price and creates a new one; everyone already
          subscribed keeps paying what they signed up for.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          New plan
        </Button>
      </div>

      {allPlans.length > 0 && (
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, id, or feature…"
        />
      )}

      {/* ── Loading / Error ── */}
      {plans.isPending && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonRows rows={3} className="*:h-52" />
        </div>
      )}
      {plans.isError && <ErrorView error={plans.error} title="Could not load plans" />}

      {/* ── Plan cards grid ── */}
      {plans.data !== undefined &&
        (plans.data.length === 0 ? (
          <Empty
            title="No plans yet"
            description="Create your first plan to start defining what tenants can buy."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(filteredPlans ?? []).map((plan) => {
              const price = plan.currentPrices.find((pr) => pr.interval === 'month');
              const yearlyPrice = plan.currentPrices.find((pr) => pr.interval === 'year');
              const tier = tierAccent(plan.id);

              return (
                <div
                  key={plan.id}
                  className={cn(
                    'flex flex-col overflow-hidden rounded-xl border transition-all',
                    plan.isActive
                      ? 'border-line bg-surface-raised hover:border-line/80 hover:shadow-md'
                      : 'border-line/50 bg-surface-sunken/60 opacity-80',
                  )}
                >
                  {/* Tier accent bar — the visual identity of each plan tier. */}
                  <div className={cn('h-1', tier.bar)} />

                  {/* Card header */}
                  <div className="px-4 pt-3 pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-[15px] font-semibold text-ink">{plan.name}</h3>
                          {plan.isDefault && (
                            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              default
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-faint">{plan.id}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        {!plan.isActive && (
                          <span className="rounded bg-ink-faint/15 px-1.5 py-0.5 text-[10px] font-medium text-ink-faint">
                            retired
                          </span>
                        )}
                        {plan.stripeProductId === null && (
                          <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                            no product
                          </span>
                        )}
                      </div>
                    </div>
                    {plan.description !== null && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                        {plan.description}
                      </p>
                    )}
                  </div>

                  {/* Price — the most important number, visually dominant */}
                  <div className="border-t border-line/40 px-4 py-3">
                    {plan.currentPrices.length === 0 ? (
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-bold text-ink-faint">—</span>
                        <span className="text-xs text-ink-faint">No price configured</span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-3">
                        {price !== undefined && (
                          <div>
                            <span className={cn('text-xl font-bold tabular-nums', tier.price)}>
                              {money(price.amountCents, price.currency)}
                            </span>
                            <span className="ml-0.5 text-xs text-ink-faint">/mo</span>
                          </div>
                        )}
                        {yearlyPrice !== undefined && (
                          <div>
                            <span className="text-sm font-medium tabular-nums text-ink-muted">
                              {money(yearlyPrice.amountCents, yearlyPrice.currency)}
                            </span>
                            <span className="ml-0.5 text-[11px] text-ink-faint">/yr</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Limits grid */}
                  <div className="border-t border-line/40 px-4 py-3">
                    <div className="mb-2 flex items-center gap-1.5">
                      <span className={cn('size-1.5 rounded-full', tier.dot)} />
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                        Limits
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                      <LimitRow label="Telephony" value={ceiling(plan.telephonyCapCents, '¢')} />
                      <LimitRow
                        label="Automation"
                        value={ceiling(plan.automationRunsPerHour, 'runs/hr')}
                      />
                      <LimitRow label="TURN" value={ceiling(plan.turnIssuancePerDay, 'creds/day')} />
                      <LimitRow
                        label="AI spend"
                        value={ceiling(plan.aiTokenBudgetMonthlyCents, '¢/mo')}
                      />
                      {plan.telephonyIncludedCents > 0 && (
                        <LimitRow
                          label="Included"
                          value={`${money(plan.telephonyIncludedCents, 'usd')} usage`}
                        />
                      )}
                      {plan.telephonyMarkupPct > 0 && (
                        <LimitRow label="Markup" value={`+${String(plan.telephonyMarkupPct)}%`} />
                      )}
                    </div>
                  </div>

                  {/* Features */}
                  {plan.features.length > 0 && (
                    <div className="border-t border-line/40 px-4 py-3">
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <span className={cn('size-1.5 rounded-full', tier.dot)} />
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                          Features
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {plan.features.map((feature) => (
                          <span
                            key={feature}
                            className={cn(
                              'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                              tier.chipBg,
                              tier.chipText,
                            )}
                            title={featureDescription(feature) ?? feature}
                          >
                            {featureLabel(feature)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Org count + processor refs */}
                  <div className="mt-auto border-t border-line/40 px-4 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-ink-faint">
                        {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'}
                      </span>
                      {plan.stripeProductId !== null && (
                        <ProcessorRef
                          label="product"
                          id={plan.stripeProductId}
                          url={plan.stripeProductUrl}
                        />
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 border-t border-line/40 px-3 py-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingFeatures(plan.id);
                      }}
                    >
                      Features
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingLimits(plan.id);
                      }}
                    >
                      Limits
                    </Button>
                    {plan.isActive && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPricing(plan.id);
                        }}
                      >
                        Set price
                      </Button>
                    )}
                    <div className="flex-1" />
                    {!plan.isDefault && plan.isActive && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={setDefault.isPending}
                        onClick={() => {
                          setDefault.mutate({ planId: plan.id });
                        }}
                      >
                        Default
                      </Button>
                    )}
                    {plan.isActive && !plan.isDefault && (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={archive.isPending}
                        onClick={() => {
                          setRetireTarget({
                            planId: plan.id,
                            name: plan.name,
                            orgCount: plan.orgCount,
                            features: plan.features,
                          });
                        }}
                      >
                        Retire
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {(filteredPlans ?? []).length === 0 && search.trim() !== '' && (
              <div className="col-span-full flex flex-col items-center gap-2 py-12">
                <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                <p className="text-sm text-ink-faint">No plans match your search.</p>
              </div>
            )}
          </div>
        ))}

      {/* ── Error states ── */}
      {archive.isError && <ErrorView error={archive.error} title="Could not retire the plan" />}
      {setDefault.isError && (
        <ErrorView error={setDefault.error} title="Could not change the default plan" />
      )}

      {/* ── Dialogs ── */}
      {creating && (
        <CreatePlanDialog
          guard={guard}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      )}

      {pricing !== null && (
        <SetPriceDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === pricing)}
          onClose={() => {
            setPricing(null);
          }}
          onPriced={() => {
            setPricing(null);
            void invalidate();
          }}
        />
      )}

      {editingFeatures !== null && (
        <EditFeaturesDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === editingFeatures)}
          onClose={() => {
            setEditingFeatures(null);
          }}
          onSaved={() => {
            setEditingFeatures(null);
            void invalidate();
          }}
        />
      )}

      {editingLimits !== null && (
        <EditLimitsDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === editingLimits)}
          onClose={() => {
            setEditingLimits(null);
          }}
          onSaved={() => {
            setEditingLimits(null);
            void invalidate();
          }}
        />
      )}

      {retireTarget !== null && (
        <RetirePlanDialog
          plan={retireTarget}
          disabled={archive.isPending}
          onClose={() => {
            setRetireTarget(null);
          }}
          onConfirm={() => {
            archive.mutate({ planId: retireTarget.planId });
            setRetireTarget(null);
          }}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Sub-components
 * -------------------------------------------------------------------------- */

/** A single limit row — label + value, compact. */
function LimitRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-ink-faint">{label}</span>
      <span className="truncate text-right font-medium text-ink">{value}</span>
    </div>
  );
}

/**
 * One processor object, linked where the processor has a console.
 *
 * `url === null` means the configured provider has no dashboard — the fake, on
 * a deployment with no Stripe account. The id still renders, because "there is
 * nowhere to look" and "there is nothing here" are different facts and only
 * one of them is a problem.
 */
function ProcessorRef({
  label,
  id,
  url,
}: {
  readonly label: string;
  readonly id: string;
  readonly url: string | null;
}) {
  const body = (
    <>
      {label}:{id.length > 18 ? `${id.slice(0, 18)}…` : id}
    </>
  );

  if (url === null) return <span title={id}>{body}</span>;

  return (
    <a
      href={url}
      target="_blank"
      /* noreferrer alongside noopener: the target is an external console, and
         the referrer would leak this deployment's own admin path to it. */
      rel="noopener noreferrer"
      title={`${id} — open in the payment processor's console`}
      className="font-mono text-[10px] text-ink-faint underline decoration-dotted hover:text-ink"
    >
      {body} ↗
    </a>
  );
}

/**
 * Confirmation dialog before retiring a plan.
 *
 * Retiring a plan does NOT eject its tenants — they keep the plan and keep
 * working. But it means no new org can subscribe to it, and the dialog
 * states both facts so the operator understands the blast radius.
 */
function RetirePlanDialog({
  plan,
  disabled,
  onClose,
  onConfirm,
}: {
  readonly plan: {
    readonly planId: string;
    readonly name: string;
    readonly orgCount: number;
    readonly features: readonly string[];
  };
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <ModalRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent size="sm" className="p-5">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-danger/15 text-danger">
            <ShieldAlert className="size-5" strokeWidth={2} />
          </span>
          <div>
            <ModalTitle>Retire {plan.name}?</ModalTitle>
            <ModalDescription>
              This plan has {String(plan.orgCount)} active organization
              {plan.orgCount === 1 ? '' : 's'}.
            </ModalDescription>
          </div>
        </div>

        <div className="space-y-3 text-sm text-ink">
          <p>
            Retiring a plan means <strong>no new organization can subscribe to it</strong>, but
            existing tenants <strong>keep the plan and keep working</strong>. They are not ejected
            or downgraded.
          </p>

          {plan.orgCount > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs font-medium text-warning">
                {String(plan.orgCount)} organization{plan.orgCount === 1 ? '' : 's'} currently on
                this plan
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                They will continue to have access to all features until their plan is manually
                changed or they cancel.
              </p>
            </div>
          )}

          {plan.features.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-muted">Features on this plan:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {plan.features.map((feature) => (
                  <Badge key={feature}>{feature}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={disabled} onClick={onConfirm}>
            {disabled ? <Spinner /> : `Retire ${plan.name}`}
          </Button>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * The ceilings and usage-billing numbers.
 *
 * Every ceiling is a THREE-state field, and the form has to make all three
 * reachable or the schema's own vocabulary is unusable from the console:
 *
 *   - empty  -> `null`, unlimited
 *   - `0`    -> none at all (telephony refused outright)
 *   - `n`    -> that many
 *
 * "Unlimited" and "none" are opposite answers that a single numeric input
 * cannot distinguish, which is why the empty string is given a meaning here
 * rather than being treated as "unchanged".
 *
 * A ceiling is NOT the value an org gets — it is the most an org on this plan
 * may be raised to. The org's own `comms.spend_policy` row holds what it is
 * actually set to, and an Owner may raise that up to this number and no
 * further. That is the bound a compromised Owner credential cannot move.
 */
function EditLimitsDialog({
  guard,
  plan,
  onClose,
  onSaved,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | {
        readonly id: string;
        readonly name: string;
        readonly telephonyCapCents: number | null;
        readonly automationRunsPerHour: number | null;
        readonly turnIssuancePerDay: number | null;
        readonly telephonyIncludedCents: number;
        readonly telephonyMarkupPct: number;
        readonly aiTokenBudgetMonthlyCents: number | null;
        readonly stripeProductId: string | null;
      }
    | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  /* Held as strings, because the empty string is a MEANING here (unlimited)
     and a numeric state would have to represent it as null anyway — one
     conversion at submit is simpler than two in both directions. */
  const [cap, setCap] = useState<string | null>(null);
  const [runs, setRuns] = useState<string | null>(null);
  const [turn, setTurn] = useState<string | null>(null);
  const [included, setIncluded] = useState<string | null>(null);
  const [markup, setMarkup] = useState<string | null>(null);
  const [aiBudget, setAiBudget] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: {
      planId: string;
      telephonyCapCents: number | null;
      automationRunsPerHour: number | null;
      turnIssuancePerDay: number | null;
      telephonyIncludedCents: number;
      telephonyMarkupPct: number;
      aiTokenBudgetMonthlyCents: number | null;
    }) => api.platformAdmin.plans.update.mutate(input),
    onSuccess: onSaved,
    onError: (error, input) => {
      guard(error, () => {
        save.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const asText = (value: number | null): string => (value === null ? '' : String(value));
  const capText = cap ?? asText(plan.telephonyCapCents);
  const runsText = runs ?? asText(plan.automationRunsPerHour);
  const turnText = turn ?? asText(plan.turnIssuancePerDay);
  const includedText = included ?? String(plan.telephonyIncludedCents);
  const markupText = markup ?? String(plan.telephonyMarkupPct);
  const aiBudgetText = aiBudget ?? asText(plan.aiTokenBudgetMonthlyCents);

  /** Empty means unlimited; anything else must be a non-negative integer. */
  const nullableInt = (text: string): number | null | 'invalid' => {
    if (text.trim() === '') return null;
    const value = Number(text);
    return Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };
  const requiredInt = (text: string): number | 'invalid' => {
    const value = Number(text);
    return text.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };

  const parsed = {
    telephonyCapCents: nullableInt(capText),
    automationRunsPerHour: nullableInt(runsText),
    turnIssuancePerDay: nullableInt(turnText),
    telephonyIncludedCents: requiredInt(includedText),
    telephonyMarkupPct: requiredInt(markupText),
    aiTokenBudgetMonthlyCents: nullableInt(aiBudgetText),
  };
  const valid = !Object.values(parsed).includes('invalid');
  /* The migration refuses an allowance on a plan with no processor product —
     there is no subscription to attach an overage invoice item to. Said here
     too, so the operator learns it before the round trip. */
  const allowanceNeedsProduct =
    plan.stripeProductId === null &&
    parsed.telephonyIncludedCents !== 'invalid' &&
    parsed.telephonyIncludedCents > 0;

  /* `field` is the LIMIT_COPY key: the explanation for a number lives in one
     place, and a missing key renders no hint rather than throwing. */
  const limitField = (
    id: string,
    label: string,
    field: string,
    value: string,
    onChange: (next: string) => void,
  ) => (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        placeholder="unlimited"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p className="mt-0.5 text-[11px] text-ink-faint">{LIMIT_COPY[field] ?? ''}</p>
    </Field>
  );

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>{plan.name} limits</ModalTitle>
        <ModalDescription>
          These are <strong>ceilings, not values</strong> — the most an org on this plan may be
          raised to. Leave a field empty for unlimited; enter 0 for none at all.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {limitField(
            'plan-cap',
            'Telephony spend cap (cents / 30 days)',
            'telephonyCapCents',
            capText,
            setCap,
          )}
          {limitField(
            'plan-runs',
            'Automation runs per hour',
            'automationRunsPerHour',
            runsText,
            setRuns,
          )}
          {limitField(
            'plan-turn',
            'TURN credentials per day',
            'turnIssuancePerDay',
            turnText,
            setTurn,
          )}
          {limitField(
            'plan-included',
            'Included telephony usage (cents / period)',
            'telephonyIncludedCents',
            includedText,
            setIncluded,
          )}
          {limitField(
            'plan-markup',
            'Usage markup (%)',
            'telephonyMarkupPct',
            markupText,
            setMarkup,
          )}
          {limitField(
            'plan-ai-budget',
            'AI assistant spend cap (cents / month)',
            'aiTokenBudgetMonthlyCents',
            aiBudgetText,
            setAiBudget,
          )}

          {allowanceNeedsProduct && (
            <p className="text-xs text-danger">
              This plan is not at the processor yet, so there is no subscription to bill an overage
              against. Set a price first — that creates the product — then come back.
            </p>
          )}

          {save.isError && <ErrorView error={save.error} title="Could not save the limits" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {(cap !== null ||
              runs !== null ||
              turn !== null ||
              included !== null ||
              markup !== null ||
              aiBudget !== null) && (
              <Button
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setCap(null);
                  setRuns(null);
                  setTurn(null);
                  setIncluded(null);
                  setMarkup(null);
                  setAiBudget(null);
                }}
              >
                Reset all
              </Button>
            )}
            <Button
              variant="primary"
              disabled={save.isPending || !valid || allowanceNeedsProduct}
              onClick={() => {
                if (!valid) return;
                save.mutate({
                  planId: plan.id,
                  telephonyCapCents: parsed.telephonyCapCents as number | null,
                  automationRunsPerHour: parsed.automationRunsPerHour as number | null,
                  turnIssuancePerDay: parsed.turnIssuancePerDay as number | null,
                  telephonyIncludedCents: parsed.telephonyIncludedCents as number,
                  telephonyMarkupPct: parsed.telephonyMarkupPct as number,
                  aiTokenBudgetMonthlyCents: parsed.aiTokenBudgetMonthlyCents as number | null,
                });
              }}
            >
              {save.isPending ? <Spinner /> : 'Save limits'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * The per-plan feature editor.
 *
 * This is what makes "which modules does this tier include" a decision an
 * operator makes, rather than a constant compiled into a migration. The list
 * comes from the server's own flag registry — never a hardcoded copy here,
 * which would drift the day a module ships and silently offer a feature the
 * service then refuses.
 *
 * Flags with `perOrg: false` are excluded rather than shown-and-disabled:
 * `telephonyLiveCredentials` is release plumbing that starts real carrier
 * spend, the service refuses it outright, and rendering a checkbox for
 * something that can only ever fail is an invitation to try.
 */
function EditFeaturesDialog({
  guard,
  plan,
  onClose,
  onSaved,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | { readonly id: string; readonly name: string; readonly features: readonly string[] }
    | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const registry = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const features = selected ?? plan?.features ?? [];

  const save = useMutation({
    mutationFn: (input: { planId: string; features: string[] }) =>
      api.platformAdmin.plans.update.mutate(input),
    onSuccess: onSaved,
    onError: (error, input) => {
      guard(error, () => {
        save.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const grantable = (registry.data ?? []).filter((flag) => flag.perOrg);

  const toggle = (flagName: string) => {
    setSelected(
      features.includes(flagName)
        ? features.filter((name) => name !== flagName)
        : [...features, flagName],
    );
  };

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>{plan.name} features</ModalTitle>
        <ModalDescription>
          Which modules this tier includes. Turning one off does not delete anything — orgs on this
          plan keep their data and lose access to it until the module is included again.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {registry.isPending && <SkeletonRows rows={4} className="*:h-10" />}
          {registry.isError && (
            <ErrorView error={registry.error} title="Could not load the flag registry" />
          )}

          {registry.data !== undefined && (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
              {grantable.map((flag) => (
                <li key={flag.flagName} className="px-3 py-2 hover:bg-surface-hover">
                  {/* htmlFor/id rather than nesting the text: the description
                      belongs to the control too, and only an explicit
                      association gets both lines read out together. */}
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`plan-feature-${flag.flagName}`}
                      className="mt-0.5"
                      checked={features.includes(flag.flagName)}
                      onChange={() => {
                        toggle(flag.flagName);
                      }}
                    />
                    <label
                      htmlFor={`plan-feature-${flag.flagName}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-sm text-ink">
                        {featureLabel(flag.flagName)}
                        <span className="ml-1.5 font-mono text-[11px] text-ink-faint">
                          {flag.flagName}
                        </span>
                      </span>
                      {/* The CUSTOMER-facing sentence, so an operator pricing
                          a tier reads the same description the person buying
                          it will. The registry's own `description` is written
                          for developers and is kept as the second line. */}
                      <span className="block text-xs text-ink-muted">
                        {featureDescription(flag.flagName) ?? flag.description}
                      </span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {save.isError && <ErrorView error={save.error} title="Could not save the features" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {selected !== null && (
              <Button
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setSelected(null);
                }}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              disabled={save.isPending || selected === null}
              onClick={() => {
                save.mutate({ planId: plan.id, features: [...features] });
              }}
            >
              {save.isPending ? <Spinner /> : 'Save features'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * All-in-one plan creation dialog — identity, features, limits, and pricing
 * in a single flow, so an operator never has to create-then-edit.
 *
 * The create mutation accepts every field the update does (features, limits,
 * description) plus `withProduct`. Pricing is the one separate call
 * (`setPrice`), chained after creation when the operator fills in an amount.
 * If the plan is created without a processor product, the price section is
 * hidden — a plan without a Stripe product cannot carry a price, and showing
 * the field would be an input the schema would refuse.
 */
function CreatePlanDialog({
  guard,
  onClose,
  onCreated,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [withProduct, setWithProduct] = useState(true);

  /* Track whether the operator manually touched the id field — once they do,
     auto-fill from name stops so their edits are not overwritten. */
  const idManuallyEdited = useRef(false);

  /* Features — same toggle model as EditFeaturesDialog. */
  const registry = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });
  const [selectedFeatures, setSelectedFeatures] = useState<readonly string[]>([]);

  /* Limits — same three-state string model as EditLimitsDialog. */
  const [cap, setCap] = useState('');
  const [runs, setRuns] = useState('');
  const [turn, setTurn] = useState('');
  const [included, setIncluded] = useState('0');
  const [markup, setMarkup] = useState('0');
  const [aiBudget, setAiBudget] = useState('');

  /* Pricing — interval + amount, only shown when withProduct is true. */
  const [priceInterval, setPriceInterval] = useState<'month' | 'year'>('month');
  const [priceAmount, setPriceAmount] = useState('');

  const create = useMutation({
    mutationFn: async (input: {
      id: string;
      name: string;
      description: string | null;
      withProduct: boolean;
      features: string[];
      telephonyCapCents: number | null;
      automationRunsPerHour: number | null;
      turnIssuancePerDay: number | null;
      telephonyIncludedCents: number;
      telephonyMarkupPct: number;
      aiTokenBudgetMonthlyCents: number | null;
    }) => {
      const plan = await api.platformAdmin.plans.create.mutate(input);
      /* Chain pricing if a price was entered and a product was created. */
      if (input.withProduct && priceAmount.trim() !== '') {
        const amountCents = Math.round(Number.parseFloat(priceAmount) * 100);
        if (Number.isInteger(amountCents) && amountCents > 0) {
          await api.platformAdmin.plans.setPrice.mutate({
            planId: input.id,
            interval: priceInterval,
            amountCents,
            currency: 'usd',
          });
        }
      }
      return plan;
    },
    onSuccess: onCreated,
    onError: (error, input) => {
      guard(error, () => {
        create.mutate(input);
      });
    },
  });

  const nullableInt = (text: string): number | null | 'invalid' => {
    if (text.trim() === '') return null;
    const value = Number(text);
    return Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };
  const requiredInt = (text: string): number | 'invalid' => {
    const value = Number(text);
    return text.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };

  const limitsParsed = {
    telephonyCapCents: nullableInt(cap),
    automationRunsPerHour: nullableInt(runs),
    turnIssuancePerDay: nullableInt(turn),
    telephonyIncludedCents: requiredInt(included),
    telephonyMarkupPct: requiredInt(markup),
    aiTokenBudgetMonthlyCents: nullableInt(aiBudget),
  };
  const limitsValid = !Object.values(limitsParsed).includes('invalid');

  const priceCents = Math.round(Number.parseFloat(priceAmount === '' ? 'NaN' : priceAmount) * 100);
  const priceValid =
    priceAmount.trim() === '' || (Number.isInteger(priceCents) && priceCents >= 0);

  const canSubmit =
    id.trim() !== '' &&
    name.trim() !== '' &&
    limitsValid &&
    priceValid &&
    (withProduct || priceAmount.trim() === '');

  const toggleFeature = (flagName: string) => {
    setSelectedFeatures((prev) =>
      prev.includes(flagName) ? prev.filter((n) => n !== flagName) : [...prev, flagName],
    );
  };

  const grantable = (registry.data ?? []).filter((f) => f.perOrg);

  const limitField = (
    fieldId: string,
    label: string,
    copyKey: string,
    value: string,
    onChange: (next: string) => void,
  ) => (
    <Field label={label} htmlFor={fieldId}>
      <Input
        id={fieldId}
        value={value}
        inputMode="numeric"
        placeholder="unlimited"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p className="mt-0.5 text-[11px] text-ink-faint">{LIMIT_COPY[copyKey] ?? ''}</p>
    </Field>
  );

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent size="lg" className="max-h-[85vh] overflow-y-auto p-5">
        <ModalTitle>New plan</ModalTitle>
        <ModalDescription>
          The id is permanent — it is written onto every org that subscribes, and it appears in logs
          and support conversations.
        </ModalDescription>

        <div className="mt-4 flex flex-col gap-5">
          {/* ── Identity ── */}
          <Section label="Identity">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="plan-name">
                <Input
                  id="plan-name"
                  value={name}
                  placeholder="Business"
                  onChange={(event) => {
                    const next = event.target.value;
                    setName(next);
                    if (!idManuallyEdited.current) {
                      setId(slugify(next));
                    }
                  }}
                />
              </Field>
              <Field label="Id" htmlFor="plan-id">
                <Input
                  id="plan-id"
                  value={id}
                  placeholder="business"
                  onChange={(event) => {
                    idManuallyEdited.current = true;
                    setId(event.target.value);
                  }}
                />
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  Auto-fills from the name. Edit directly to override.
                </p>
              </Field>
            </div>
            <Field label="Description" htmlFor="plan-desc">
              <Input
                id="plan-desc"
                value={description}
                placeholder="For teams that need it all."
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
              />
            </Field>
            <label className="flex items-start gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={withProduct}
                onChange={(event) => {
                  setWithProduct(event.target.checked);
                }}
              />
              <span>
                Create a product at the payment processor. Uncheck for a free tier — a plan created
                without one can never carry a price.
              </span>
            </label>
          </Section>

          {/* ── Features ── */}
          <Section label="Features">
            {registry.isPending && <SkeletonRows rows={3} className="*:h-8" />}
            {registry.isError && (
              <ErrorView error={registry.error} title="Could not load the flag registry" />
            )}
            {registry.data !== undefined && grantable.length > 0 && (
              <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
                {grantable.map((flag) => (
                  <li key={flag.flagName} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-hover">
                    <input
                      type="checkbox"
                      id={`create-feature-${flag.flagName}`}
                      className="mt-0.5"
                      checked={selectedFeatures.includes(flag.flagName)}
                      onChange={() => {
                        toggleFeature(flag.flagName);
                      }}
                    />
                    <label
                      htmlFor={`create-feature-${flag.flagName}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-sm text-ink">
                        {featureLabel(flag.flagName)}
                      </span>
                      <span className="block text-[11px] text-ink-muted">
                        {featureDescription(flag.flagName) ?? flag.description}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {registry.data !== undefined && grantable.length === 0 && (
              <p className="text-xs text-ink-faint">No grantable features in the registry.</p>
            )}
          </Section>

          {/* ── Limits ── */}
          <Section label="Limits">
            <p className="mb-1 text-[11px] text-ink-muted">
              Ceilings, not values — the most an org on this plan may be raised to. Leave empty for
              unlimited; enter 0 for none at all.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {limitField(
                'create-cap',
                'Telephony spend cap (¢ / 30 days)',
                'telephonyCapCents',
                cap,
                setCap,
              )}
              {limitField(
                'create-runs',
                'Automation runs per hour',
                'automationRunsPerHour',
                runs,
                setRuns,
              )}
              {limitField(
                'create-turn',
                'TURN credentials per day',
                'turnIssuancePerDay',
                turn,
                setTurn,
              )}
              {limitField(
                'create-ai',
                'AI spend cap (¢ / month)',
                'aiTokenBudgetMonthlyCents',
                aiBudget,
                setAiBudget,
              )}
              {limitField(
                'create-included',
                'Included telephony usage (¢)',
                'telephonyIncludedCents',
                included,
                setIncluded,
              )}
              {limitField(
                'create-markup',
                'Usage markup (%)',
                'telephonyMarkupPct',
                markup,
                setMarkup,
              )}
            </div>
          </Section>

          {/* ── Pricing ── */}
          {withProduct && (
            <Section label="Pricing">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Interval" htmlFor="create-interval">
                  <div className="flex gap-1.5">
                    {(['month', 'year'] as const).map((value) => (
                      <Button
                        key={value}
                        {...(priceInterval === value ? ({ variant: 'primary' } as const) : {})}
                        onClick={() => {
                          setPriceInterval(value);
                        }}
                      >
                        {value}ly
                      </Button>
                    ))}
                  </div>
                </Field>
                <Field label="Amount (USD)" htmlFor="create-amount">
                  <Input
                    id="create-amount"
                    value={priceAmount}
                    inputMode="decimal"
                    placeholder="29.00"
                    onChange={(event) => {
                      setPriceAmount(event.target.value);
                    }}
                  />
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    Leave empty to create without a price — you can set one later.
                  </p>
                </Field>
              </div>
            </Section>
          )}

          {create.isError && <ErrorView error={create.error} title="Could not create the plan" />}

          <div className="flex justify-end gap-2 border-t border-line/40 pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || !canSubmit}
              onClick={() => {
                if (!canSubmit) return;
                create.mutate({
                  id: id.trim(),
                  name: name.trim(),
                  description: description.trim() === '' ? null : description.trim(),
                  withProduct,
                  features: [...selectedFeatures],
                  telephonyCapCents: limitsParsed.telephonyCapCents as number | null,
                  automationRunsPerHour: limitsParsed.automationRunsPerHour as number | null,
                  turnIssuancePerDay: limitsParsed.turnIssuancePerDay as number | null,
                  telephonyIncludedCents: limitsParsed.telephonyIncludedCents as number,
                  telephonyMarkupPct: limitsParsed.telephonyMarkupPct as number,
                  aiTokenBudgetMonthlyCents: limitsParsed.aiTokenBudgetMonthlyCents as number | null,
                });
              }}
            >
              {create.isPending ? <Spinner /> : 'Create plan'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/** Collapsible section wrapper for the create dialog. */
function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line/40 bg-surface-sunken/30 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">{label}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

/**
 * Repricing, with the consequence stated before the button.
 *
 * The count and the "they stay" sentence are the whole point of this dialog
 * existing rather than an inline field: an operator changing a number must see
 * that existing customers do NOT move before they commit, because that is the
 * behaviour they are most likely to assume wrongly in either direction.
 */
function SetPriceDialog({
  guard,
  plan,
  onClose,
  onPriced,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | {
        readonly id: string;
        readonly name: string;
        readonly orgCount: number;
        readonly currentPrices: readonly {
          readonly interval: 'month' | 'year';
          readonly amountCents: number;
          readonly currency: string;
        }[];
      }
    | undefined;
  readonly onClose: () => void;
  readonly onPriced: () => void;
}) {
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [amount, setAmount] = useState('');

  const setPrice = useMutation({
    mutationFn: (input: {
      planId: string;
      interval: 'month' | 'year';
      amountCents: number;
      currency: string;
    }) => api.platformAdmin.plans.setPrice.mutate(input),
    onSuccess: onPriced,
    onError: (error, input) => {
      guard(error, () => {
        setPrice.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const existing = plan.currentPrices.find((price) => price.interval === interval);
  /* Parsed to an INTEGER number of cents at the edge. Nothing downstream ever
     does decimal arithmetic on money — the route, the catalog and the
     processor all take minor units. */
  const amountCents = Math.round(Number.parseFloat(amount === '' ? 'NaN' : amount) * 100);
  const valid = Number.isInteger(amountCents) && amountCents >= 0;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>Set {plan.name} price</ModalTitle>
        <ModalDescription>
          {existing === undefined ? (
            <>No {interval}ly price yet — this creates the first one.</>
          ) : (
            <>
              Currently {money(existing.amountCents, existing.currency)}/{interval}. Saving retires
              that price and creates a new one.{' '}
              <strong>
                The {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'} on this plan keep paying
                what they signed up for
              </strong>{' '}
              — only new subscriptions get the new amount.
            </>
          )}
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Interval" htmlFor="plan-interval">
            <div className="flex gap-1.5">
              {(['month', 'year'] as const).map((value) => (
                <Button
                  key={value}
                  {...(interval === value ? ({ variant: 'primary' } as const) : {})}
                  onClick={() => {
                    setInterval(value);
                  }}
                >
                  {value}ly
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Amount (USD)" htmlFor="plan-amount">
            <Input
              id="plan-amount"
              value={amount}
              inputMode="decimal"
              placeholder="29.00"
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          </Field>

          {setPrice.isError && <ErrorView error={setPrice.error} title="Could not set the price" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={setPrice.isPending || !valid}
              onClick={() => {
                setPrice.mutate({ planId: plan.id, interval, amountCents, currency: 'usd' });
              }}
            >
              {setPrice.isPending ? <Spinner /> : 'Save price'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}
