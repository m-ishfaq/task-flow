import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  KeyRound,
  Layers,
  Lock,
  Settings2,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import type { OrgId } from '@taskflow/contracts';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { money } from './shared.js';
import {
  Button,
  Empty,
  Field,
  Input,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StepUpGate, StatCard } from './shared.js';

/* -------------------------------------------------------------------------- *
 * AI Models — premium operator view
 *
 * Provider catalog with kind-colored badges, summary stat cards,
 * enhanced modals, and a polished spend report.
 * -------------------------------------------------------------------------- */

const PROVIDER_META: Record<string, { readonly label: string; readonly color: string }> = {
  anthropic: { label: 'Anthropic', color: 'text-amber-700 bg-amber-500/10 border-amber-500/20' },
  openai: { label: 'OpenAI', color: 'text-emerald-700 bg-emerald-500/10 border-emerald-500/20' },
  gemini: { label: 'Gemini', color: 'text-sky-700 bg-sky-500/10 border-sky-500/20' },
};

function providerMeta(kind: string) {
  return (
    PROVIDER_META[kind] ?? {
      label: kind,
      color: 'text-ink-faint bg-surface-hover border-line',
    }
  );
}

/**
 * The AI provider catalog and its per-org overrides (Phase 15 §2.3, §3.3).
 *
 * This tab did not exist until now. The router comment that introduces
 * `platformAdmin.ai` already calls it "the 'AI Models' tab" — the backend
 * shipped anticipating a UI that nothing ever built, the identical
 * "shipped backend, no consumer" gap CLAUDE.md's own "Phase 15 §4 — the
 * assistant's missing frontend" section documents once already for
 * `ai.chat.send`. Found here the same way: someone trying to actually
 * configure a provider had nowhere to do it.
 */
export function AiTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<{ readonly id: string; readonly label: string } | null>(
    null,
  );

  const providers = useQuery({
    queryKey: keys.platformAiProviders(),
    queryFn: async () => wire(await api.platformAdmin.ai.providers.list.query(undefined)),
  });

  const invalidateProviders = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.platformAiProviders() });
  };

  const setDefault = useMutation({
    mutationFn: (input: { id: string }) => api.platformAdmin.ai.providers.setDefault.mutate(input),
    onSuccess: invalidateProviders,
    onError: (error, input) => {
      guard(error, () => {
        setDefault.mutate(input);
      });
    },
  });

  if (errorCodeOf(providers.error) === 'STEP_UP_REQUIRED')
    return <StepUpGate onStepUp={onStepUp} />;

  const allProviders = providers.data ?? [];
  const defaultCount = allProviders.filter((p) => p.isDefault).length;
  const kindCount = new Set(allProviders.map((p) => p.provider)).size;

  return (
    <section aria-label="AI Models" className="flex flex-col gap-5">
      {/* Summary stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Bot} label="Providers" value={allProviders.length} accent={allProviders.length > 0} />
        <StatCard
          icon={Sparkles}
          label="Default"
          value={defaultCount}
          accent={defaultCount === 1}
        />
        <StatCard icon={Layers} label="Models" value={allProviders.length} />
        <StatCard icon={Settings2} label="Kinds" value={kindCount} />
      </div>

      {/* Provider catalog */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <p className="max-w-2xl text-xs text-ink-muted">
            The model catalog every org's assistant, standup narration, and other AI features
            resolve against. One row here is one API key plus a model — an org with no override uses
            whichever row is marked default.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            New provider
          </Button>
        </div>

        {providers.isPending && <SkeletonRows rows={3} className="mt-3 *:h-16" />}
        {providers.isError && (
          <ErrorView error={providers.error} title="Could not load providers" />
        )}

        {providers.data !== undefined &&
          (providers.data.length === 0 ? (
            <Empty
              title="No providers configured"
              description="Nothing here can complete a request until at least one is added — every AI feature in the product refuses with PLAN_REQUIRED or a resolver error until then."
            />
          ) : (
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
              {providers.data.map((row) => {
                const meta = providerMeta(row.provider);
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-hover/30"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-ink">{row.label}</p>
                        <span
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-[11px] font-medium',
                            meta.color,
                          )}
                        >
                          {meta.label}
                        </span>
                        <span className="rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                          {row.model}
                        </span>
                        {row.isDefault && (
                          <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                            DEFAULT
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-ink-faint">
                        Added {formatDate(row.createdAt)}
                        {row.updatedAt !== row.createdAt && ` · rotated ${formatDate(row.updatedAt)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!row.isDefault && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={setDefault.isPending}
                          onClick={() => {
                            setDefault.mutate({ id: row.id });
                          }}
                        >
                          Set default
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setRotating({ id: row.id, label: row.label });
                        }}
                      >
                        <KeyRound className="size-3" strokeWidth={2} />
                        Rotate
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ))}

        {setDefault.isError && (
          <ErrorView error={setDefault.error} title="Could not change the default provider" />
        )}
      </div>

      <OrgOverridePanel guard={guard} providers={allProviders} onStepUp={onStepUp} />

      <SpendReportPanel onStepUp={onStepUp} />

      {creating && (
        <CreateProviderDialog
          guard={guard}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={() => {
            setCreating(false);
            void invalidateProviders();
          }}
        />
      )}

      {rotating !== null && (
        <RotateKeyDialog
          guard={guard}
          target={rotating}
          onClose={() => {
            setRotating(null);
          }}
          onRotated={() => {
            setRotating(null);
            void invalidateProviders();
          }}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * CreateProviderDialog — enhanced modal with visual kind selector
 * -------------------------------------------------------------------------- */

const PROVIDER_KINDS = [
  { value: 'anthropic' as const, label: 'Anthropic', placeholder: 'claude-sonnet-4', color: 'border-amber-500/40 bg-amber-500/[0.06] text-amber-700', activeColor: 'border-amber-500 bg-amber-500/10 text-amber-700 ring-2 ring-amber-500/20' },
  { value: 'openai' as const, label: 'OpenAI', placeholder: 'gpt-4o', color: 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700', activeColor: 'border-emerald-500 bg-emerald-500/10 text-emerald-700 ring-2 ring-emerald-500/20' },
  { value: 'gemini' as const, label: 'Gemini', placeholder: 'gemini-2.0-flash', color: 'border-sky-500/40 bg-sky-500/[0.06] text-sky-700', activeColor: 'border-sky-500 bg-sky-500/10 text-sky-700 ring-2 ring-sky-500/20' },
] as const;

function CreateProviderDialog({
  guard,
  onClose,
  onCreated,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [provider, setProvider] = useState<'anthropic' | 'openai' | 'gemini'>('anthropic');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  const create = useMutation({
    mutationFn: (input: {
      provider: 'anthropic' | 'openai' | 'gemini';
      model: string;
      apiKey: string;
      label: string;
      isDefault: boolean;
    }) => api.platformAdmin.ai.providers.create.mutate(input),
    onSuccess: onCreated,
    onError: (error, input) => {
      guard(error, () => {
        create.mutate(input);
      });
    },
  });

  const canSubmit = model.trim() !== '' && apiKey.trim() !== '' && label.trim() !== '';

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="max-h-[85vh] overflow-y-auto p-0">
        <div className="px-5 pt-5">
          <ModalTitle>New provider</ModalTitle>
          <ModalDescription>
            The key is encrypted at rest under its own data key and never sent back to this console
            once saved — rotating it is the only way to change it later.
          </ModalDescription>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Visual kind selector */}
          <div>
            <p className="mb-2 text-xs font-medium text-ink-faint">Provider</p>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDER_KINDS.map((kind) => {
                const active = provider === kind.value;
                return (
                  <button
                    key={kind.value}
                    type="button"
                    onClick={() => {
                      setProvider(kind.value);
                    }}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-xs font-medium transition-all',
                      active ? kind.activeColor : cn(kind.color, 'hover:border-ink-faint/30'),
                    )}
                  >
                    <Bot className="size-5" strokeWidth={1.5} />
                    {kind.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Model + Label side by side */}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Model"
              htmlFor="ai-provider-model"
              hint="The exact model id the provider expects."
            >
              <Input
                id="ai-provider-model"
                value={model}
                placeholder={PROVIDER_KINDS.find((k) => k.value === provider)?.placeholder ?? ''}
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              />
            </Field>

            <Field
              label="Label"
              htmlFor="ai-provider-label"
              hint="How this row reads in the list."
            >
              <Input
                id="ai-provider-label"
                value={label}
                placeholder="Default Sonnet"
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
              />
            </Field>
          </div>

          {/* API Key */}
          <Field label="API key" htmlFor="ai-provider-key">
            <div className="relative">
              <KeyRound
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                strokeWidth={2}
              />
              <Input
                id="ai-provider-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder="sk-..."
                className="pl-9"
                onChange={(event) => {
                  setApiKey(event.target.value);
                }}
              />
            </div>
          </Field>

          {/* Default toggle */}
          <label className="flex items-start gap-3 rounded-xl border border-line bg-surface-sunken/50 px-4 py-3">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => {
                setIsDefault(event.target.checked);
              }}
              className="mt-0.5"
            />
            <span className="text-xs text-ink-muted">
              <span className="font-medium text-ink">Make this the default</span> — every org with
              no override resolves to it. Clears the previous default; only one row may hold it.
            </span>
          </label>

          {create.isError && <ErrorView error={create.error} title="Could not add the provider" />}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || !canSubmit}
              onClick={() => {
                create.mutate({
                  provider,
                  model: model.trim(),
                  apiKey: apiKey.trim(),
                  label: label.trim(),
                  isDefault,
                });
              }}
            >
              {create.isPending ? <Spinner /> : 'Add provider'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/* -------------------------------------------------------------------------- *
 * RotateKeyDialog — enhanced with warning banner
 * -------------------------------------------------------------------------- */

function RotateKeyDialog({
  guard,
  target,
  onClose,
  onRotated,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly target: { readonly id: string; readonly label: string };
  readonly onClose: () => void;
  readonly onRotated: () => void;
}) {
  const [apiKey, setApiKey] = useState('');

  const rotate = useMutation({
    mutationFn: (input: { id: string; apiKey: string }) =>
      api.platformAdmin.ai.providers.rotateKey.mutate(input),
    onSuccess: onRotated,
    onError: (error, input) => {
      guard(error, () => {
        rotate.mutate(input);
      });
    },
  });

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-0">
        <div className="px-5 pt-5">
          <ModalTitle>Rotate key — {target.label}</ModalTitle>
          <ModalDescription>
            Replaces the stored key immediately. Every completion this row serves after this saves
            uses the new key; there is no grace period.
          </ModalDescription>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Warning banner */}
          <div className="flex items-start gap-3 rounded-xl bg-amber-500/[0.06] px-4 py-3">
            <Lock
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-600"
              strokeWidth={2}
            />
            <p className="text-[11px] text-amber-700">
              The current key will be permanently replaced. Any service using it will fail until
              updated. This action cannot be undone.
            </p>
          </div>

          <Field label="New API key" htmlFor="ai-provider-rotate-key">
            <div className="relative">
              <KeyRound
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                strokeWidth={2}
              />
              <Input
                id="ai-provider-rotate-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder="sk-..."
                className="pl-9"
                onChange={(event) => {
                  setApiKey(event.target.value);
                }}
              />
            </div>
          </Field>

          {rotate.isError && <ErrorView error={rotate.error} title="Could not rotate the key" />}

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={rotate.isPending || apiKey.trim() === ''}
              onClick={() => {
                rotate.mutate({ id: target.id, apiKey: apiKey.trim() });
              }}
            >
              {rotate.isPending ? <Spinner /> : 'Rotate key'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/* -------------------------------------------------------------------------- *
 * OrgOverridePanel — enhanced org search and override card
 * -------------------------------------------------------------------------- */

/**
 * One org's override — set, cleared, or read back, none of which the
 * console could do before this tab: `orgOverride.set`/`.clear` shipped in
 * §3.3 with no `get`, so this panel's own read is what closes that.
 *
 * The org picker reuses `broadcast-tab.tsx`'s exact shape: the same
 * `orgs.list` page (`keys.platformOrgs(null)`), filtered client-side by
 * name/slug — a real directory search would need a server-side query
 * `orgs.list` does not take, and this is one page of orgs, the same
 * trade-off that tab's own header already documents.
 */
function OrgOverridePanel({
  guard,
  providers,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly providers: readonly { readonly id: string; readonly label: string }[];
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [orgQuery, setOrgQuery] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<{
    readonly orgId: OrgId;
    readonly name: string;
    readonly slug: string;
  } | null>(null);
  const [chosenProviderId, setChosenProviderId] = useState('');

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
          candidate.name.toLowerCase().includes(q) || candidate.slug.toLowerCase().includes(q),
      )
      .slice(0, 8);
  })();

  const override = useQuery({
    queryKey: keys.platformAiOrgOverride(selectedOrg?.orgId ?? ''),
    queryFn: async () => {
      if (selectedOrg === null) throw new Error('No org selected.');
      return wire(await api.platformAdmin.ai.orgOverride.get.query({ orgId: selectedOrg.orgId }));
    },
    enabled: selectedOrg !== null,
  });

  const invalidateOverride = async () => {
    if (selectedOrg === null) return;
    await queryClient.invalidateQueries({
      queryKey: keys.platformAiOrgOverride(selectedOrg.orgId),
    });
  };

  const setOverride = useMutation({
    mutationFn: (input: { orgId: OrgId; providerConfigId: string }) =>
      api.platformAdmin.ai.orgOverride.set.mutate(input),
    onSuccess: invalidateOverride,
    onError: (error, input) => {
      guard(error, () => {
        setOverride.mutate(input);
      });
    },
  });

  const clearOverride = useMutation({
    mutationFn: (input: { orgId: OrgId }) => api.platformAdmin.ai.orgOverride.clear.mutate(input),
    onSuccess: invalidateOverride,
    onError: (error, input) => {
      guard(error, () => {
        clearOverride.mutate(input);
      });
    },
  });

  if (errorCodeOf(override.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const overriddenId = override.data?.providerConfigId ?? null;
  const currentLabel =
    overriddenId === null
      ? 'Using the global default'
      : (providers.find((row) => row.id === overriddenId)?.label ??
        'An unknown provider (it may have been removed)');

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">Org overrides</h3>
      <p className="mt-1 max-w-2xl text-xs text-ink-muted">
        One org, one model — for a customer piloting a different provider or needing a specific
        version, without touching the deployment-wide default.
      </p>

      <div className="mt-3 max-w-md">
        <Field label="Organization" htmlFor="ai-override-org-search" hint="Search by name or slug.">
          {selectedOrg === null ? (
            <>
              <div className="relative">
                <Users
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                  strokeWidth={2}
                />
                <Input
                  id="ai-override-org-search"
                  value={orgQuery}
                  placeholder="Search organizations…"
                  className="pl-9"
                  onChange={(event) => {
                    setOrgQuery(event.target.value);
                  }}
                />
              </div>
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
                          setChosenProviderId('');
                        }}
                      >
                        <span className="min-w-0 truncate text-ink">
                          {candidate.name}{' '}
                          <span className="text-ink-faint">({candidate.slug})</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-sm text-ink">
              <span className="min-w-0 flex-1 truncate">
                {selectedOrg.name} <span className="text-ink-faint">({selectedOrg.slug})</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-xs text-ink-faint hover:text-ink"
                onClick={() => {
                  setSelectedOrg(null);
                }}
              >
                Change
              </button>
            </div>
          )}
        </Field>
      </div>

      {selectedOrg !== null && (
        <div className="mt-3 max-w-md space-y-3 rounded-xl border border-line bg-surface p-4">
          {override.isPending ? (
            <SkeletonRows rows={1} className="*:h-8" />
          ) : override.isError ? (
            <ErrorView error={override.error} title="Could not load this org's override" />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-muted">Currently:</span>
                <span
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium',
                    overriddenId !== null
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface-sunken text-ink-muted',
                  )}
                >
                  {currentLabel}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={chosenProviderId}
                  onChange={(event) => {
                    setChosenProviderId(event.target.value);
                  }}
                  className="h-9 flex-1 rounded-lg border border-line/50 bg-surface-sunken px-3 text-sm text-ink"
                >
                  <option value="">Choose a provider…</option>
                  {providers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  disabled={chosenProviderId === '' || setOverride.isPending}
                  onClick={() => {
                    setOverride.mutate({
                      orgId: selectedOrg.orgId,
                      providerConfigId: chosenProviderId,
                    });
                  }}
                >
                  Set
                </Button>
              </div>

              {overriddenId !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={clearOverride.isPending}
                  onClick={() => {
                    clearOverride.mutate({ orgId: selectedOrg.orgId });
                  }}
                >
                  <Trash2 className="size-3" strokeWidth={2} />
                  Clear override
                </Button>
              )}

              {(setOverride.isError || clearOverride.isError) && (
                <ErrorView
                  error={setOverride.error ?? clearOverride.error}
                  title="Could not change this org's override"
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * SpendReportPanel — enhanced with summary stats and polished expandable rows
 * -------------------------------------------------------------------------- */

type SpendRow = Awaited<ReturnType<typeof api.platformAdmin.ai.spendReport.query>>[number];

/**
 * Cross-org spend by model — §3.3's cost-attribution view.
 *
 * Each row shows the org by NAME, not a bare uuid — the query joins
 * `identity.orgs` specifically so an operator never has to cross-reference
 * the Organizations tab by hand to know whose spend they are looking at.
 *
 * The actual prompt/response text is deliberately never shown here, and
 * never stored anywhere in `ai.usage_ledger` in the first place — that
 * would mean persisting org-authored content (card/chat/comment text an
 * org member typed) in a table every operator can read, a real scope and
 * retention decision this pass did not make. What IS shown, expandable per
 * row and hidden by default so the table stays scannable: the real token
 * counts and the published per-model rate `costCentsFor` multiplied to
 * reach the total — "on what basis" a number was reached, without needing
 * the content itself.
 */
function SpendReportPanel({ onStepUp }: { readonly onStepUp: () => void }) {
  const sinceDays = 30;
  const [expanded, setExpanded] = useState<string | null>(null);
  const spend = useQuery({
    queryKey: keys.platformAiSpend(sinceDays),
    queryFn: async () => wire(await api.platformAdmin.ai.spendReport.query({ sinceDays })),
  });

  if (errorCodeOf(spend.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const rows = spend.data ?? [];
  const totalSpend = rows.reduce((sum, r) => sum + r.totalCents, 0);
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  const uniqueOrgs = new Set(rows.map((r) => r.orgId)).size;
  const uniqueModels = new Set(rows.map((r) => r.model)).size;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">Spend, last {sinceDays} days</h3>
      <p className="mt-1 max-w-2xl text-xs text-ink-muted">
        Grouped by org and model. Expand a row for the token counts and rate the cost was computed
        from — never the prompt or response text itself, which this deployment does not store.
      </p>

      {/* Spend summary stats */}
      {!spend.isPending && !spend.isError && rows.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={CircleDollarSign}
            label="Total spend"
            value={money(totalSpend, 'usd')}
            accent
          />
          <StatCard icon={Layers} label="Total calls" value={totalCalls} />
          <StatCard icon={Users} label="Orgs" value={uniqueOrgs} />
          <StatCard icon={Bot} label="Models" value={uniqueModels} />
        </div>
      )}

      {spend.isPending && <SkeletonRows rows={3} className="mt-3 *:h-10" />}
      {spend.isError && <ErrorView error={spend.error} title="Could not load the spend report" />}

      {spend.data !== undefined &&
        (spend.data.length === 0 ? (
          <p className="mt-3 text-xs text-ink-faint">No completions recorded in this window.</p>
        ) : (
          <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {spend.data.map((row) => {
              const rowKey = `${row.orgId}-${row.model}`;
              const open = expanded === rowKey;
              const meta = providerMeta(
                row.model.startsWith('claude')
                  ? 'anthropic'
                  : row.model.startsWith('gpt')
                    ? 'openai'
                    : row.model.startsWith('gemini')
                      ? 'gemini'
                      : '',
              );
              return (
                <div key={rowKey}>
                  <button
                    type="button"
                    onClick={() => {
                      setExpanded(open ? null : rowKey);
                    }}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs transition-colors hover:bg-surface-hover/40"
                  >
                    {open ? (
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-ink-faint"
                      />
                    ) : (
                      <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-ink-faint"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink">{row.orgName}</span>
                      <span className="ml-1 text-ink-faint">({row.orgSlug})</span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                        meta.color,
                      )}
                    >
                      {row.model}
                    </span>
                    <span className="shrink-0 text-ink-muted">
                      {String(row.calls)} {row.calls === 1 ? 'call' : 'calls'}
                    </span>
                    <span className="w-16 shrink-0 text-right font-medium tabular-nums text-ink">
                      {money(row.totalCents, 'usd')}
                    </span>
                  </button>

                  {open && <SpendRowDetail row={row} />}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}

function SpendRowDetail({ row }: { readonly row: SpendRow }) {
  return (
    <div className="border-t border-line/60 bg-surface-sunken/30 px-4 py-3 pl-9 text-[11px] text-ink-muted">
      <p>
        <span className="tabular-nums text-ink">{row.totalInputTokens.toLocaleString()}</span> input
        tokens
        {row.rate !== null && ` at ${formatRate(row.rate.inputCentsPerMillion)}`}
        {' + '}
        <span className="tabular-nums text-ink">{row.totalOutputTokens.toLocaleString()}</span>{' '}
        output tokens
        {row.rate !== null && ` at ${formatRate(row.rate.outputCentsPerMillion)}`}
        {row.rate === null && (
          <span className="text-warning">
            {' '}
            — this model has since been removed from the rate table; the total shown is what was
            actually billed, not re-derived.
          </span>
        )}
      </p>
    </div>
  );
}

/** `250` (cents per million) -> `"$2.50 / 1M tokens"`. */
function formatRate(centsPerMillion: number): string {
  return `$${(centsPerMillion / 100).toFixed(2)} / 1M tokens`;
}
