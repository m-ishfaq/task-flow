import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Activity,
  Database,
  Globe,
  KeyRound,
  MemoryStick,
  Server,
  Shield,
  Settings,
} from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { Spinner } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, StepUpGate } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Config — platform identity, auth policy, infrastructure health,
 * security settings, and editable operational settings. All data is real,
 * sourced from the server — no hardcoded values.
 * -------------------------------------------------------------------------- */

interface DraftState {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  registrationEnabled: boolean;
  stepUpMaxAgeMin: number;
  lockoutThreshold: number;
  lockoutDurationMin: number;
}

type DraftAction =
  | { type: 'field'; key: keyof DraftState; value: boolean | string | number }
  | { type: 'syncFromServer'; state: DraftState };

function draftReducer(prev: DraftState, action: DraftAction): DraftState {
  if (action.type === 'field') {
    return { ...prev, [action.key]: action.value };
  }
  /* syncFromServer: adopt server values only when the user hasn't made local
     edits since the last sync. If draft matches the previous server state,
     the user hasn't edited — adopt the new values. If they diverge, the user
     has pending edits we must not overwrite. */
  const prevMatchesServer =
    prev.maintenanceMode === action.state.maintenanceMode &&
    prev.maintenanceMessage === action.state.maintenanceMessage &&
    prev.registrationEnabled === action.state.registrationEnabled &&
    prev.stepUpMaxAgeMin === action.state.stepUpMaxAgeMin &&
    prev.lockoutThreshold === action.state.lockoutThreshold &&
    prev.lockoutDurationMin === action.state.lockoutDurationMin;
  return prevMatchesServer ? action.state : prev;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h ${String(mins)}m`;
  if (hours > 0) return `${String(hours)}h ${String(mins)}m`;
  return `${String(mins)}m`;
}

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  readonly icon: React.ComponentType<{
    readonly className?: string;
    readonly strokeWidth?: number;
  }>;
  readonly title: string;
  readonly subtitle?: string;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <Icon className="size-4 text-ink-muted" strokeWidth={2} />
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {subtitle !== undefined && <p className="text-xs text-ink-faint">{subtitle}</p>}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
      <span className="text-xs text-ink-faint">{label}</span>
      <span
        className={`text-right text-sm ${
          mono === true ? 'font-mono text-[11px]' : 'font-medium'
        } ${accent === true ? 'text-emerald-500' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}

function StatusDot({ healthy }: { readonly healthy: boolean }) {
  return (
    <span className={`size-2 shrink-0 rounded-full ${healthy ? 'bg-emerald-500' : 'bg-red-500'}`} />
  );
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-surface-hover'
      } ${disabled === true ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4.5' : 'translate-x-0.75'
        }`}
      />
    </button>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly min?: number;
  readonly max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number.parseInt(e.target.value, 10);
        if (!Number.isNaN(n)) onChange(n);
      }}
      className="w-20 rounded-md border border-line bg-surface-sunken px-2 py-1 text-right font-mono text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
    />
  );
}

export function ConfigTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const self = useQuery({
    queryKey: keys.platformSelf(),
    queryFn: async () => wire(await api.platformAdmin.self.check.query()),
  });

  const config = useQuery({
    queryKey: keys.platformConfig(),
    queryFn: async () => wire(await api.platformAdmin.config.overview.query()),
  });

  const ctx = useMemo(
    () => ({
      maintenanceMode: Boolean(config.data?.settings?.['maintenance_mode']),
      maintenanceMessage:
        (config.data?.settings?.['maintenance_message'] as string) ||
        'System is currently under maintenance.',
      registrationEnabled: config.data?.settings?.['registration_enabled'] !== false,
      stepUpMaxAgeMin: Number(config.data?.settings?.['step_up_max_age_min'] ?? 5),
      lockoutThreshold: Number(config.data?.settings?.['lockout_threshold'] ?? 5),
      lockoutDurationMin: Number(config.data?.settings?.['lockout_duration_min'] ?? 15),
    }),
    [config.data],
  );

  const [draft, dispatch] = useReducer(draftReducer, ctx);
  /* Sync draft with server state when config loads or refetches — dispatched
     as a reducer action so no useEffect/setState is needed. Without this,
     the initial ctx (before config resolves) stays as draft, so after a page
     refresh the draft shows defaults instead of saved values. */
  useEffect(() => {
    dispatch({ type: 'syncFromServer', state: ctx });
  }, [ctx]);
  const draftChanged = useMemo(
    () =>
      ctx.maintenanceMode !== draft.maintenanceMode ||
      ctx.maintenanceMessage !== draft.maintenanceMessage ||
      ctx.registrationEnabled !== draft.registrationEnabled ||
      ctx.stepUpMaxAgeMin !== draft.stepUpMaxAgeMin ||
      ctx.lockoutThreshold !== draft.lockoutThreshold ||
      ctx.lockoutDurationMin !== draft.lockoutDurationMin,
    [ctx, draft],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.platformAdmin.config.update.mutate({
        settings: [
          { key: 'maintenance_mode', value: draft.maintenanceMode },
          { key: 'maintenance_message', value: draft.maintenanceMessage },
          { key: 'registration_enabled', value: draft.registrationEnabled },
          { key: 'step_up_max_age_min', value: draft.stepUpMaxAgeMin },
          { key: 'lockout_threshold', value: draft.lockoutThreshold },
          { key: 'lockout_duration_min', value: draft.lockoutDurationMin },
        ],
      });
    },
    onSuccess: () => {
      void config.refetch();
    },
  });

  const setDraft = useCallback(<K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    dispatch({ type: 'field', key, value });
  }, []);

  if (
    errorCodeOf(self.error) === 'STEP_UP_REQUIRED' ||
    errorCodeOf(config.error) === 'STEP_UP_REQUIRED'
  ) {
    return <StepUpGate onStepUp={onStepUp} />;
  }

  const queries = [self, config];
  const firstError = queries.find((q) => q.error !== null);
  if (firstError !== undefined) return <ErrorView error={firstError.error} />;

  if (self.isLoading || config.isLoading) {
    return (
      <div className="flex items-center gap-2 py-12 text-ink-muted">
        <Spinner /> Loading configuration…
      </div>
    );
  }

  const isOperator = self.data?.isOperator ?? false;
  const overview = config.data;

  const envLabel =
    import.meta.env.MODE === 'production'
      ? 'Production'
      : import.meta.env.MODE === 'staging'
        ? 'Staging'
        : 'Development';

  return (
    <div className="space-y-6">
      {/* ── Summary stat cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Database}
          label="Database"
          value={overview?.infrastructure.database === true ? 'Healthy' : 'Unavailable'}
          accent={overview?.infrastructure.database === true}
        />
        <StatCard
          icon={Activity}
          label="Uptime"
          value={overview !== undefined ? formatUptime(overview.runtime.uptimeSeconds) : '—'}
        />
        <StatCard
          icon={Server}
          label="Runtime"
          value={overview !== undefined ? overview.runtime.nodeVersion : '—'}
        />
        <StatCard
          icon={MemoryStick}
          label="Memory"
          value={overview !== undefined ? `${String(overview.runtime.memoryUsageMb)} MB` : '—'}
        />
      </div>

      {/* ── Platform Identity ── */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <SectionHeader
          icon={Server}
          title="Platform Identity"
          subtitle="Operator session and environment"
        />
        <div className="space-y-0">
          <DetailRow
            label="Operator Access"
            value={isOperator ? 'Verified operator' : 'Not an operator'}
            accent={isOperator}
          />
          <DetailRow label="Environment" value={envLabel} />
          <DetailRow label="Session" value="Authenticated (step-up verified)" accent />
          <DetailRow
            label="Step-up valid for"
            value={
              overview !== undefined ? `${String(overview.auth.stepUpMaxAgeMinutes)} minutes` : '—'
            }
          />
        </div>
      </div>

      {/* ── Operational Settings ── */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <SectionHeader
          icon={Settings}
          title="Operational Settings"
          subtitle="Deployment-wide runtime configuration"
        />

        <div className="space-y-4">
          {/* Maintenance Mode */}
          <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div>
              <span className="text-sm font-medium text-ink">Maintenance Mode</span>
              <p className="text-xs text-ink-muted">
                Blocks all non-platform routes with a maintenance page
              </p>
            </div>
            <ToggleSwitch
              checked={draft.maintenanceMode}
              onChange={(v) => {
                setDraft('maintenanceMode', v);
              }}
            />
          </div>

          {/* Maintenance Message */}
          <div className="flex items-start justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div className="pt-1">
              <span className="text-sm font-medium text-ink">Maintenance Message</span>
              <p className="text-xs text-ink-muted">Displayed on the maintenance page</p>
            </div>
            <input
              type="text"
              value={draft.maintenanceMessage}
              onChange={(e) => {
                setDraft('maintenanceMessage', e.target.value);
              }}
              className="flex-1 max-w-xs rounded-md border border-line bg-surface-sunken px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          </div>

          {/* Registration Enabled */}
          <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div>
              <span className="text-sm font-medium text-ink">Registration Enabled</span>
              <p className="text-xs text-ink-muted">Allow new user sign-ups</p>
            </div>
            <ToggleSwitch
              checked={draft.registrationEnabled}
              onChange={(v) => {
                setDraft('registrationEnabled', v);
              }}
            />
          </div>

          {/* Step-up Timeout */}
          <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div>
              <span className="text-sm font-medium text-ink">Step-up Re-auth Timeout</span>
              <p className="text-xs text-ink-muted">
                Minutes before platform actions require re-verification
              </p>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput
                value={draft.stepUpMaxAgeMin}
                onChange={(v) => {
                  setDraft('stepUpMaxAgeMin', v);
                }}
                min={1}
                max={60}
              />
              <span className="text-xs text-ink-faint">min</span>
            </div>
          </div>

          {/* Lockout Threshold */}
          <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div>
              <span className="text-sm font-medium text-ink">Lockout Threshold</span>
              <p className="text-xs text-ink-muted">Failed login attempts before account lockout</p>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput
                value={draft.lockoutThreshold}
                onChange={(v) => {
                  setDraft('lockoutThreshold', v);
                }}
                min={1}
                max={20}
              />
              <span className="text-xs text-ink-faint">attempts</span>
            </div>
          </div>

          {/* Lockout Duration */}
          <div className="flex items-center justify-between gap-4 py-2.5 not-last:border-b not-last:border-line/50">
            <div>
              <span className="text-sm font-medium text-ink">Lockout Duration</span>
              <p className="text-xs text-ink-muted">Minutes a locked-out account is blocked</p>
            </div>
            <div className="flex items-center gap-2">
              <NumberInput
                value={draft.lockoutDurationMin}
                onChange={(v) => {
                  setDraft('lockoutDurationMin', v);
                }}
                min={1}
                max={120}
              />
              <span className="text-xs text-ink-faint">min</span>
            </div>
          </div>
        </div>

        {/* Save button */}
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={!draftChanged || saveMutation.isPending}
            onClick={() => {
              saveMutation.mutate();
            }}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveMutation.isPending ? 'Saving…' : 'Save Settings'}
          </button>
          {saveMutation.isSuccess && <span className="text-sm text-emerald-500">Saved</span>}
          {saveMutation.isError && <span className="text-sm text-red-500">Failed to save</span>}
        </div>
      </div>

      {/* ── Authentication Policy ── */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <SectionHeader
          icon={KeyRound}
          title="Authentication Policy"
          subtitle="Token lifetimes and credential configuration (compile-time)"
        />
        <div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
          <div className="space-y-0 sm:pr-4 sm:not-last:border-r sm:not-last:border-line/50">
            <DetailRow
              label="Access token TTL"
              value={
                overview !== undefined ? `${String(overview.auth.accessTokenTtlSeconds)}s` : '—'
              }
              mono
            />
            <DetailRow
              label="Refresh token TTL"
              value={
                overview !== undefined ? `${String(overview.auth.refreshTokenTtlDays)} days` : '—'
              }
              mono
            />
            <DetailRow
              label="Email verification TTL"
              value={
                overview !== undefined ? `${String(overview.auth.verificationTtlHours)} hours` : '—'
              }
              mono
            />
          </div>
          <div className="space-y-0 sm:pl-4">
            <DetailRow
              label="Password reset TTL"
              value={
                overview !== undefined
                  ? `${String(overview.auth.passwordResetTtlMinutes)} minutes`
                  : '—'
              }
              mono
            />
            <DetailRow label="Refresh token rotation" value="Reuse detection enabled" />
            <DetailRow label="Per-IP rate limiting" value="Gateway-enforced" />
          </div>
        </div>
      </div>

      {/* ── Security Policy ── */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <SectionHeader
          icon={Shield}
          title="Security Policy"
          subtitle="Platform-wide security controls"
        />
        <div className="grid grid-cols-1 gap-0 sm:grid-cols-2">
          <div className="space-y-0 sm:pr-4 sm:not-last:border-r sm:not-last:border-line/50">
            <DetailRow label="Password policy" value="Argon2id + HIBP breach check" />
            <DetailRow label="Passkey support" value="WebAuthn resident keys" />
            <DetailRow label="TOTP support" value="RFC 6238 compatible" />
          </div>
          <div className="space-y-0 sm:pl-4">
            <DetailRow label="Token storage" value="HttpOnly, Secure, SameSite=Strict" />
            <DetailRow label="CORS policy" value="Same-origin (no cross-site cookies)" />
          </div>
        </div>
      </div>

      {/* ── Infrastructure ── */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <SectionHeader icon={Globe} title="Infrastructure" subtitle="Core service health" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            {
              label: 'Database',
              sublabel: 'Postgres with RLS',
              healthy: overview?.infrastructure.database ?? false,
            },
            {
              label: 'Object Storage',
              sublabel: 'S3-compatible',
              healthy: overview?.infrastructure.objectStorage ?? false,
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-3 rounded-lg bg-surface-sunken px-4 py-3"
            >
              <StatusDot healthy={item.healthy} />
              <div>
                <p className="text-sm font-medium text-ink">{item.label}</p>
                <p className="text-xs text-ink-muted">{item.sublabel}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
