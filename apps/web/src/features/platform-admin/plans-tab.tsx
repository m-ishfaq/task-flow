import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { CreditCard, LayoutGrid, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '@taskflow/client';
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
import {
  ModalIconHeader,
  SectionHeader,
  StepUpGate,
  TableSearch,
  ceiling,
  money,
} from './shared.js';
import { cn } from '../../lib/cn.js';

/**
 * The plan catalog.
 *
 * The tab that replaces opening the Stripe dashboard. Two things here are
 * deliberate rather than incidental:
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

  /* The mockup's own "MOST SOLD" ribbon is a marketing label with nothing
     behind it in an operator console — this is not a pricing page a
     customer browses, it's a tool an operator reads real numbers from. The
     honest equivalent is the same ribbon POSITION carrying a number this
     table already has: the active, sellable plan with the most orgs
     actually on it. Never rendered with only one active plan (nothing to
     stand out from) or when nobody is on any plan yet (an empty-database
     ribbon is noise, not a signal). */
  const activePlans = (plans.data ?? []).filter((plan) => plan.isActive);
  const mostActivePlanId = (() => {
    if (activePlans.length < 2) return null;
    const top = activePlans.reduce((max, plan) => (plan.orgCount > max.orgCount ? plan : max));
    return top.orgCount > 0 ? top.id : null;
  })();

  return (
    <section aria-label="Plans">
      <SectionHeader
        icon={LayoutGrid}
        title="Plans"
        subtitle="catalog, limits, entitlements — editable per org, no migration"
      />
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

      {plans.data !== undefined && plans.data.length > 0 && (
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, id, or feature…"
        />
      )}

      {plans.isPending && <SkeletonRows rows={3} className="mt-3 *:h-24" />}
      {plans.isError && <ErrorView error={plans.error} title="Could not load plans" />}

      {plans.data !== undefined &&
        (plans.data.length === 0 ? (
          <Empty
            title="No plans yet"
            description="Create your first plan to start defining what tenants can buy."
          />
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(filteredPlans ?? []).map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                featured={plan.id === mostActivePlanId}
                setDefaultPending={setDefault.isPending}
                archivePending={archive.isPending}
                onEditFeatures={() => {
                  setEditingFeatures(plan.id);
                }}
                onEditLimits={() => {
                  setEditingLimits(plan.id);
                }}
                onSetPrice={() => {
                  setPricing(plan.id);
                }}
                onSetDefault={() => {
                  setDefault.mutate({ planId: plan.id });
                }}
                onRetire={() => {
                  setRetireTarget({
                    planId: plan.id,
                    name: plan.name,
                    orgCount: plan.orgCount,
                    features: plan.features,
                  });
                }}
              />
            ))}
            {(filteredPlans ?? []).length === 0 && search.trim() !== '' && (
              <p className="col-span-full px-4 py-8 text-center text-sm text-ink-faint">
                No plans match your search.
              </p>
            )}
          </div>
        ))}

      {archive.isError && <ErrorView error={archive.error} title="Could not retire the plan" />}
      {setDefault.isError && (
        <ErrorView error={setDefault.error} title="Could not change the default plan" />
      )}

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

type PlanRow = Wire<Awaited<ReturnType<typeof api.platformAdmin.plans.list.query>>>[number];

/**
 * One plan, as a pricing-page-shaped card — Design Bible §18's own mockup,
 * replacing what used to be a dense, paragraph-like row of every field
 * concatenated with middle dots. The real data is unchanged; only the
 * shape changed, from "everything on one run-on line" to "the four numbers
 * that actually matter, plus the processor links and remaining actions
 * folded into a footer instead of competing with them for space."
 *
 * `featured` draws the accent ring/border — see `PlansTab`'s own
 * `mostActivePlanId` computation for why that is a real, data-driven
 * signal (orgs actually on the plan) rather than the mockup's own
 * hardcoded "MOST SOLD" marketing ribbon, which has no meaning in a
 * console an operator reads real numbers from.
 */
function PlanCard({
  plan,
  featured,
  setDefaultPending,
  archivePending,
  onEditFeatures,
  onEditLimits,
  onSetPrice,
  onSetDefault,
  onRetire,
}: {
  readonly plan: PlanRow;
  readonly featured: boolean;
  readonly setDefaultPending: boolean;
  readonly archivePending: boolean;
  readonly onEditFeatures: () => void;
  readonly onEditLimits: () => void;
  readonly onSetPrice: () => void;
  readonly onSetDefault: () => void;
  readonly onRetire: () => void;
}) {
  const hasAnalytics = plan.features.includes('analytics');

  return (
    <div
      className={cn(
        'relative flex flex-col gap-3 rounded-xl border p-4',
        featured ? 'border-accent/50 bg-accent/[0.03] ring-1 ring-accent/20' : 'border-line',
        !plan.isActive && 'opacity-70',
      )}
    >
      {featured && (
        <span className="absolute -top-2.5 left-4 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-ink uppercase">
          Most active
        </span>
      )}

      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
          {plan.name}
          {plan.isDefault && <Badge>default</Badge>}
          {!plan.isActive && <Badge>retired</Badge>}
        </p>
        <p className="font-mono text-xs text-ink-faint">{plan.id}</p>
      </div>

      <p className="text-lg font-semibold tracking-tight text-ink">
        {plan.currentPrices.length === 0 ? (
          <span className="text-sm font-normal text-ink-faint">no price configured</span>
        ) : (
          plan.currentPrices
            .map((price) => `${money(price.amountCents, price.currency)}/${price.interval}`)
            .join(' · ')
        )}
      </p>

      <dl className="flex flex-col gap-1.5 border-t border-line/60 pt-3 text-xs">
        <PlanLimitRow label="Telephony" value={ceiling(plan.telephonyCapCents, 'cents')} />
        <PlanLimitRow
          label="AI budget"
          value={ceiling(plan.aiTokenBudgetMonthlyCents, 'cents/mo')}
        />
        <PlanLimitRow label="Automation" value={ceiling(plan.automationRunsPerHour, 'runs/hr')} />
        <div className="flex items-center justify-between">
          <dt className="text-ink-faint">Analytics</dt>
          <dd className={hasAnalytics ? 'text-success' : 'text-ink-faint'}>
            {hasAnalytics ? '✓' : '—'}
          </dd>
        </div>
      </dl>

      {plan.description !== null && <p className="text-xs text-ink-muted">{plan.description}</p>}

      <p className="text-xs text-ink-faint">
        {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'}
        {plan.features.length > 0 && ` · ${plan.features.join(', ')}`}
      </p>

      {/* The processor ids, with a link where there is a console to link to.
          A stored id is a CLAIM that the object was created; it is not
          evidence the object is still there, or that it belongs to the
          Stripe account this deployment currently points at. Only looking
          settles that, so the card makes looking one click. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-ink-faint">
        {plan.stripeProductId === null ? (
          <span>not yet at the processor — created on first price</span>
        ) : (
          <ProcessorRef label="product" id={plan.stripeProductId} url={plan.stripeProductUrl} />
        )}
        {plan.currentPrices.map((price) =>
          price.stripePriceId === null ? null : (
            <ProcessorRef
              key={price.id}
              label={price.interval}
              id={price.stripePriceId}
              url={price.stripePriceUrl}
            />
          ),
        )}
      </p>

      <div className="mt-auto flex flex-col gap-1.5 border-t border-line/60 pt-3">
        <button
          type="button"
          onClick={onEditLimits}
          className="text-left text-xs font-medium text-accent hover:underline"
        >
          Edit limits
        </button>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onEditFeatures}>
            Features
          </Button>
          {/* Shown for ANY active plan, including one with no processor
              product yet. `setPrice` creates the product on demand — hiding
              this button for a product-less plan was a dead end: migration
              0063 seeds `free` and `pro` without one (a migration cannot
              call Stripe), so on a fresh database neither seeded plan could
              ever be given a price and no org could ever upgrade. */}
          {plan.isActive && (
            <Button size="sm" onClick={onSetPrice}>
              Set price
            </Button>
          )}
          {!plan.isDefault && plan.isActive && (
            <Button size="sm" disabled={setDefaultPending} onClick={onSetDefault}>
              Make default
            </Button>
          )}
          {plan.isActive && !plan.isDefault && (
            <Button size="sm" variant="danger" disabled={archivePending} onClick={onRetire}>
              Retire
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanLimitRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
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
        <ModalIconHeader icon={ShieldAlert} tone="danger">
          <ModalTitle>Retire {plan.name}?</ModalTitle>
          <ModalDescription>
            This plan has {String(plan.orgCount)} active organization
            {plan.orgCount === 1 ? '' : 's'}.
          </ModalDescription>
        </ModalIconHeader>

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
              <p className="mt-0.5 text-xs text-ink-muted">
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
      <p className="mt-0.5 text-xs text-ink-faint">{LIMIT_COPY[field] ?? ''}</p>
    </Field>
  );

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalIconHeader icon={LayoutGrid} tone="accent">
          <ModalTitle>{plan.name} limits</ModalTitle>
          <ModalDescription>
            These are <strong>ceilings, not values</strong> — the most an org on this plan may be
            raised to. Leave a field empty for unlimited; enter 0 for none at all.
          </ModalDescription>
        </ModalIconHeader>

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
      className="underline decoration-dotted hover:text-ink"
    >
      {body} ↗
    </a>
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
        <ModalIconHeader icon={ShieldCheck} tone="accent">
          <ModalTitle>{plan.name} features</ModalTitle>
          <ModalDescription>
            Which modules this tier includes. Turning one off does not delete anything — orgs on
            this plan keep their data and lose access to it until the module is included again.
          </ModalDescription>
        </ModalIconHeader>

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
                        <span className="ml-1.5 font-mono text-xs text-ink-faint">
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
  const [withProduct, setWithProduct] = useState(true);

  const create = useMutation({
    mutationFn: (input: { id: string; name: string; withProduct: boolean }) =>
      api.platformAdmin.plans.create.mutate(input),
    onSuccess: onCreated,
    onError: (error, input) => {
      guard(error, () => {
        create.mutate(input);
      });
    },
  });

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalIconHeader icon={LayoutGrid} tone="accent">
          <ModalTitle>New plan</ModalTitle>
          <ModalDescription>
            The id is permanent — it is written onto every org that subscribes, and it appears in
            logs and support conversations. Features and ceilings are edited after creation.
          </ModalDescription>
        </ModalIconHeader>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Id" htmlFor="plan-id">
            <Input
              id="plan-id"
              value={id}
              placeholder="business"
              onChange={(event) => {
                setId(event.target.value);
              }}
            />
          </Field>
          <Field label="Name" htmlFor="plan-name">
            <Input
              id="plan-name"
              value={name}
              placeholder="Business"
              onChange={(event) => {
                setName(event.target.value);
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
            {/* Not inferable from a zero price: "this tier is never charged
                for" is a decision, and a plan created without a processor
                product cannot grow one later. */}
            <span>
              Create a product at the payment processor. Uncheck for a free tier — a plan created
              without one can never carry a price.
            </span>
          </label>

          {create.isError && <ErrorView error={create.error} title="Could not create the plan" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || id.trim() === '' || name.trim() === ''}
              onClick={() => {
                create.mutate({ id: id.trim(), name: name.trim(), withProduct });
              }}
            >
              {create.isPending ? <Spinner /> : 'Create'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
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
        <ModalIconHeader icon={CreditCard} tone="accent">
          <ModalTitle>Set {plan.name} price</ModalTitle>
          <ModalDescription>
            {existing === undefined ? (
              <>No {interval}ly price yet — this creates the first one.</>
            ) : (
              <>
                Currently {money(existing.amountCents, existing.currency)}/{interval}. Saving
                retires that price and creates a new one.{' '}
                <strong>
                  The {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'} on this plan keep paying
                  what they signed up for
                </strong>{' '}
                — only new subscriptions get the new amount.
              </>
            )}
          </ModalDescription>
        </ModalIconHeader>

        <div className="flex flex-col gap-3">
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
