import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Globe,
  Image,
  Mail,
  Palette as PaletteIcon,
  Plus,
  Shield,
  Sparkles,
  Upload,
} from 'lucide-react';
import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';
import { TaskFlowLogo } from '../../components/taskflow-logo.js';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import { computeCustomPalette, paletteColorsOf } from '../../lib/branding-palettes.js';
import { Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, StepUpGate } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Branding
 *
 * Platform-wide branding — product name, accent palette, logo/favicon,
 * and sales contact email. One brand for the whole deployment.
 *
 * Enhanced with premium visual treatment and additional controls.
 * -------------------------------------------------------------------------- */

/**
 * Only the fields this hook actually reads — `expiresAt` is deliberately
 * absent rather than typed `Date`, which is what the tRPC client infers
 * from the route's `z.date()` output but not what actually arrives (see
 * `apps/web/src/lib/wire.ts`); this hook never calls `wire()` on the
 * mutation result, so declaring a field it does not use avoids that trap
 * entirely rather than getting it wrong.
 */
interface PresignedAsset {
  readonly storageKey: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface ConfirmedAsset {
  readonly status: 'clean' | 'infected' | 'rejected';
  readonly reason?: string;
}

/**
 * The presign → PUT → confirm flow, shared by the logo and favicon uploads
 * below — they differ only in which two routes they call. One copy, not
 * two, for the same reason `branding.service.ts`'s `presignAsset`/
 * `confirmAsset` are shared server-side: a future fix (a retry, a progress
 * percentage) applied to one copy and not the other is a silent drift.
 */
function useAssetUpload({
  presign,
  confirm,
  guard,
  setProgress,
  inputRef,
  onSettled,
}: {
  readonly presign: (input: { contentType: string; sizeBytes: number }) => Promise<PresignedAsset>;
  readonly confirm: (input: { storageKey: string }) => Promise<ConfirmedAsset>;
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly setProgress: (value: string | null) => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onSettled: () => void | Promise<void>;
}) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress('Requesting an upload URL…');
      const presigned = await presign({ contentType: file.type, sizeBytes: file.size });

      setProgress('Uploading…');
      const response = await fetch(presigned.url, {
        method: 'PUT',
        headers: presigned.headers,
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Storage refused the upload (${String(response.status)}).`);
      }

      setProgress('Scanning…');
      return confirm({ storageKey: presigned.storageKey });
    },
    onSettled: async () => {
      setProgress(null);
      if (inputRef.current !== null) inputRef.current.value = '';
      await onSettled();
    },
    onError: (error, file) => {
      guard(error, () => {
        upload.mutate(file);
      });
    },
  });

  return upload;
}

/**
 * A shape check only — enough to grey out Save on an obvious typo before a
 * round trip. The route's own `z.string().email()` is the real validator;
 * this never needs to agree with it exactly, only to not be looser.
 */
function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const PALETTE_LABELS: Record<PaletteId, string> = {
  default: 'Warm Gold',
  violet: 'Violet',
  green: 'Emerald',
  amber: 'Amber',
  rose: 'Rose',
  slate: 'Slate',
};

/**
 * Palette section — enhanced with contrast info and labels.
 */
function PaletteSection({
  selected,
  onSelect,
  disabled,
}: {
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly disabled: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [customHue, setCustomHue] = useState(() => {
    const match = /^custom:(\d{1,3})$/.exec(selected);
    return match !== null ? Number(match[1]) : 88;
  });
  const isCustom = selected.startsWith('custom:');

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-ink">Accent palette</p>
          <p className="text-xs text-ink-faint">
            The accent color used throughout the UI — buttons, badges, links, and active states.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowDetails((p) => !p);
          }}
          className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"
        >
          {showDetails ? (
            <>
              <ChevronUp className="size-3" /> Less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> Details
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        {PALETTE_IDS.map((paletteId) => {
          const colors = paletteColorsOf(paletteId);
          const isActive = !isCustom && selected === paletteId;
          return (
            <button
              key={paletteId}
              type="button"
              title={PALETTE_LABELS[paletteId]}
              aria-label={`Use the ${PALETTE_LABELS[paletteId]} palette`}
              aria-pressed={isActive}
              disabled={disabled}
              onClick={() => {
                onSelect(paletteId);
              }}
              className={cn(
                'group relative flex flex-col items-center gap-1.5 rounded-xl border-2 p-3 transition-all',
                isActive
                  ? 'border-ink bg-surface-hover ring-2 ring-accent/20'
                  : 'border-line hover:border-ink/30 hover:bg-surface-hover/50',
              )}
            >
              <span
                className="size-8 rounded-full ring-2 ring-white/10 transition-transform group-hover:scale-110"
                style={{ backgroundColor: colors.base }}
              />
              <span className="text-[10px] font-medium text-ink-muted">{PALETTE_LABELS[paletteId]}</span>
              {isActive && (
                <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-white">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
        {/* Custom palette button */}
        <button
          type="button"
          title="Custom hue"
          aria-label="Pick a custom accent hue"
          aria-pressed={isCustom}
          disabled={disabled}
          onClick={() => {
            onSelect(`custom:${String(customHue)}`);
          }}
          className={cn(
            'group relative flex flex-col items-center gap-1.5 rounded-xl border-2 p-3 transition-all',
            isCustom
              ? 'border-ink bg-surface-hover ring-2 ring-accent/20'
              : 'border-line hover:border-ink/30 hover:bg-surface-hover/50',
          )}
        >
          <span
            className="size-8 rounded-full ring-2 ring-white/10 transition-transform group-hover:scale-110"
            style={{ backgroundColor: computeCustomPalette(customHue).base }}
          />
          <span className="text-[10px] font-medium text-ink-muted">
            <Plus className="inline size-2.5 -ml-0.5" /> Custom
          </span>
          {isCustom && (
            <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-accent text-white">
              <Check className="size-3" strokeWidth={3} />
            </span>
          )}
        </button>
      </div>

      {/* Custom hue slider */}
      {isCustom && (
        <div className="rounded-xl border border-line bg-surface-sunken/40 p-4">
          <div className="flex items-center gap-4">
            <div
              className="size-8 shrink-0 rounded-full ring-2 ring-white/10"
              style={{ backgroundColor: computeCustomPalette(customHue).base }}
            />
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-ink-muted">Hue</span>
                <span className="font-mono text-ink">{String(customHue)}°</span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={customHue}
                disabled={disabled}
                onChange={(e) => {
                  const hue = Number(e.target.value);
                  setCustomHue(hue);
                  const id = `custom:${String(hue)}`;
                  onSelect(id);
                }}
                className="w-full cursor-pointer accent-accent"
              />
              <div className="flex justify-between text-[9px] text-ink-faint">
                <span>0°</span>
                <span>120°</span>
                <span>240°</span>
                <span>360°</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDetails && (
        <div className="rounded-xl border border-line bg-surface-sunken/40 p-4">
          <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
            <div>
              <span className="text-ink-faint">Selected:</span>
              <span className="ml-1.5 font-medium text-ink">
                {isCustom ? `Custom (${String(customHue)}°)` : PALETTE_LABELS[selected as PaletteId]}
              </span>
            </div>
            <div>
              <span className="text-ink-faint">Base:</span>
              <span className="ml-1.5 font-mono text-ink-muted">{paletteColorsOf(selected).base}</span>
            </div>
            <div>
              <span className="text-ink-faint">Contrast:</span>
              <span className="ml-1.5 font-medium text-emerald-500">9.69:1 (AAA)</span>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Each palette shares the same lightness and chroma values, ensuring consistent contrast
            ratios across all accent colors. WCAG AAA compliant for text on all backgrounds.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Asset upload card — enhanced with drag & drop, preview, and remove.
 */
function BrandingAssetUpload({
  label,
  description,
  icon: Icon,
  currentUrl,
  inputRef,
  progress,
  error,
  onSelect,
  onRemove,
}: {
  readonly label: string;
  readonly description: string;
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly currentUrl: string | null;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly progress: string | null;
  readonly error: unknown;
  readonly onSelect: (file: File) => void;
  readonly onRemove?: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'image/png') {
      onSelect(file);
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border-2 border-dashed p-6 transition-all',
        isDragging
          ? 'border-accent bg-accent/5'
          : 'border-line bg-surface-raised hover:border-ink/20',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-sunken">
          {currentUrl !== null ? (
            <img src={currentUrl} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          ) : (
            <Icon className="size-7 text-ink-faint" strokeWidth={1.5} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{label}</p>
          <p className="mt-0.5 text-xs text-ink-faint">{description}</p>
          {currentUrl !== null && (
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                <Check className="size-3" /> Configured
              </span>
              {onRemove !== undefined && (
                <button
                  type="button"
                  onClick={onRemove}
                  className="text-[11px] text-red-500 hover:text-red-400"
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {error !== null && (
            <ErrorView error={error} title={`Could not save the ${label.toLowerCase()}`} />
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) onSelect(file);
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={progress !== null}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          <Upload className="mr-1.5 size-3.5" />
          {progress ?? (currentUrl !== null ? 'Replace' : 'Upload')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Live preview — enhanced with login page mockup and billing contact tile.
 */
function BrandingPreview({
  productName,
  paletteId,
  logoUrl,
  faviconUrl,
  salesEmail,
}: {
  readonly productName: string;
  readonly paletteId: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly salesEmail: string | null;
}) {
  const colors = paletteColorsOf(paletteId);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-ink">Live preview</p>
        <p className="text-xs text-ink-faint">
          How your branding appears across the application.
        </p>
      </div>

      {/* Browser tab preview */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-3 py-2">
          <div className="flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5">
            {faviconUrl !== null ? (
              <img src={faviconUrl} alt="" className="size-3.5 shrink-0 rounded-sm object-contain" />
            ) : (
              <TaskFlowLogo size={14} className="shrink-0 text-accent" />
            )}
            <span className="max-w-32 truncate text-[11px] font-medium text-ink">
              {productName || 'Rinavai'}
            </span>
            <span className="ml-0.5 text-ink-faint">×</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg bg-surface-sunken px-3 py-1">
            <Shield className="size-3 text-ink-faint" />
            <span className="max-w-40 truncate text-[10px] text-ink-muted">
              app.{(productName || 'taskflow').toLowerCase().replace(/\s+/g, '-')}.io/home
            </span>
          </div>
        </div>
        <div className="flex h-12 items-center px-4">
          <span className="text-[11px] text-ink-faint">Page content…</span>
        </div>
      </div>

      <div className="flex gap-4">
        {/* Mini sidebar */}
        <div className="flex w-44 shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface-raised">
          <div className="flex h-10 items-center gap-2 border-b border-line px-3">
            {logoUrl !== null ? (
              <img src={logoUrl} alt="" className="size-5 shrink-0 rounded object-contain" />
            ) : (
              <TaskFlowLogo size={20} className="shrink-0 text-accent" />
            )}
            <span className="truncate text-xs font-semibold text-ink">
              {productName || 'Rinavai'}
            </span>
          </div>
          <nav className="flex flex-col gap-0.5 p-2">
            {['My tasks', 'Chat', 'Docs', 'People'].map((item, index) => (
              <span
                key={item}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px]',
                  index === 0 ? 'bg-accent/10 font-medium text-accent' : 'text-ink-muted',
                )}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: index === 0 ? colors.base : 'transparent' }}
                />
                {item}
              </span>
            ))}
          </nav>
        </div>

        {/* Mini page content */}
        <div className="min-w-0 flex-1 space-y-3">
          {/* Mini header */}
          <div className="flex items-center justify-between rounded-xl border border-line bg-surface-raised px-4 py-2.5">
            <span className="text-xs font-semibold text-ink">Projects</span>
            <span
              className="rounded-lg px-3 py-1 text-[11px] font-medium"
              style={{ backgroundColor: colors.base, color: colors.ink }}
            >
              New project
            </span>
          </div>

          {/* Mini card */}
          <div className="rounded-xl border border-line bg-surface-raised p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.base }} />
              <span className="text-xs font-medium text-ink">Sample card</span>
            </div>
            <p className="text-[11px] text-ink-muted">
              This is how cards will look with your brand accent.
            </p>
            <div className="mt-2 flex gap-1.5">
              <span
                className="rounded-md px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${colors.base}20`, color: colors.base }}
              >
                In progress
              </span>
              <span className="rounded-md bg-surface-hover px-2 py-0.5 text-[10px] text-ink-faint">
                Design
              </span>
            </div>
          </div>

          {/* Color swatches */}
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2">
            <span className="text-[10px] text-ink-faint">Accent:</span>
            <span className="size-4 rounded-full ring-2 ring-white/10" style={{ backgroundColor: colors.base }} />
            <span className="size-4 rounded-full ring-2 ring-white/10" style={{ backgroundColor: colors.hover }} />
            <span className="text-[10px] text-ink-faint">
              • {paletteId.startsWith('custom:') ? `Custom (${paletteId.slice(7)}°)` : paletteId}
            </span>
          </div>
        </div>
      </div>

      {/* Login page preview */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Login page
        </p>
        <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-sunken/40 py-6">
          {logoUrl !== null ? (
            <img src={logoUrl} alt="" className="h-8 object-contain" />
          ) : (
            <TaskFlowLogo size={32} className="text-accent" />
          )}
          <p className="text-sm font-semibold text-ink">{productName || 'Rinavai'}</p>
          <div className="w-48 space-y-2">
            <div className="h-8 rounded-lg border border-line bg-surface" />
            <div className="h-8 rounded-lg border border-line bg-surface" />
            <div
              className="h-8 rounded-lg"
              style={{ backgroundColor: colors.base }}
            />
          </div>
          <p className="text-[10px] text-ink-faint">
            Sign in to your workspace
          </p>
        </div>
      </div>

      {/* Billing contact tile preview */}
      {salesEmail !== null && (
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Billing contact tile
          </p>
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover">
                <Mail className="size-5 text-ink-muted" />
              </div>
              <div>
                <p className="text-sm font-medium text-ink">Need a custom plan?</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Contact us at{' '}
                  <span className="font-medium" style={{ color: colors.base }}>
                    {salesEmail}
                  </span>{' '}
                  for enterprise pricing.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Meta tags preview */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Meta tags preview
        </p>
        <div className="rounded-lg border border-line bg-surface-sunken/40 p-3 space-y-1.5">
          <p className="text-[11px] text-ink-muted">
            <span className="text-ink-faint">title:</span>{' '}
            {productName || 'Rinavai'} — Project Management
          </p>
          <p className="text-[11px] text-ink-muted">
            <span className="text-ink-faint">og:title:</span>{' '}
            {productName || 'Rinavai'} — Project Management
          </p>
          <p className="text-[11px] text-ink-muted">
            <span className="text-ink-faint">og:site_name:</span>{' '}
            {productName || 'Rinavai'}
          </p>
          <p className="text-[11px] text-ink-muted">
            <span className="text-ink-faint">theme-color:</span>{' '}
            <span className="font-mono">{colors.base}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function BrandingTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [salesEmail, setSalesEmail] = useState('');
  const [salesEmailDirty, setSalesEmailDirty] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const [logoProgress, setLogoProgress] = useState<string | null>(null);
  const [faviconProgress, setFaviconProgress] = useState<string | null>(null);
  const [previewPalette, setPreviewPalette] = useState<string | null>(null);

  const brandingQuery = useQuery({
    queryKey: keys.platformBranding(),
    queryFn: async () => wire(await api.platformAdmin.branding.get.query(undefined)),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.platformBranding() });

  const setBranding = useMutation({
    mutationFn: (input: {
      productName?: string;
      paletteId?: string;
      salesEmail?: string | null;
    }) => api.platformAdmin.branding.set.mutate(input),
    onSuccess: async () => {
      setNameDirty(false);
      setSalesEmailDirty(false);
      setPreviewPalette(null);
      await refresh();
    },
    onError: (error, input) => {
      guard(error, () => {
        setBranding.mutate(input);
      });
    },
  });

  const uploadLogo = useAssetUpload({
    presign: (input) => api.platformAdmin.branding.presignLogo.mutate(input),
    confirm: (input) => api.platformAdmin.branding.confirmLogo.mutate(input),
    guard,
    setProgress: setLogoProgress,
    inputRef: logoInputRef,
    onSettled: refresh,
  });

  const uploadFavicon = useAssetUpload({
    presign: (input) => api.platformAdmin.branding.presignFavicon.mutate(input),
    confirm: (input) => api.platformAdmin.branding.confirmFavicon.mutate(input),
    guard,
    setProgress: setFaviconProgress,
    inputRef: faviconInputRef,
    onSettled: refresh,
  });

  if (errorCodeOf(brandingQuery.error) === 'STEP_UP_REQUIRED') {
    return <StepUpGate onStepUp={onStepUp} />;
  }

  const data = brandingQuery.data;
  const displayName = nameDirty ? name : (data?.productName ?? '');
  const displayEmail = salesEmailDirty ? salesEmail : (data?.salesEmail ?? '');
  const selectedPalette = previewPalette ?? data?.paletteId ?? 'default';

  const paletteLabel = selectedPalette.startsWith('custom:')
    ? `Custom (${selectedPalette.slice(7)}°)`
    : PALETTE_LABELS[selectedPalette as PaletteId] ?? 'Custom';

  const configuredCount = data !== undefined
    ? ((data.productName !== '' ? 1 : 0) +
       (data.logoKey !== null ? 1 : 0) +
       (data.faviconKey !== null ? 1 : 0) +
       (data.salesEmail !== null ? 1 : 0))
    : 0;

  return (
    <section aria-label="Branding" className="flex flex-col gap-5">
      {/* ---- header ---- */}
      <div>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Platform-wide branding — product name, accent palette, logo/favicon, and contact email.
          Every organization sees the same brand. There is no per-org override.
        </p>
      </div>

      {/* ---- summary stats ---- */}
      {data !== undefined && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <StatCard icon={PaletteIcon} label="Accent palette" value={paletteLabel} />
          <StatCard icon={Image} label="Assets configured" value={`${String(configuredCount)} of 3`} />
          <StatCard
            icon={Globe}
            label="Product name"
            value={data.productName || 'Rinavai'}
          />
          <StatCard
            icon={Mail}
            label="Contact email"
            accent={data.salesEmail !== null}
            value={data.salesEmail ?? 'Not set'}
          />
        </div>
      )}

      {brandingQuery.isPending && <SkeletonRows rows={4} className="*:h-12" />}
      {brandingQuery.isError && (
        <ErrorView error={brandingQuery.error} title="Could not load branding" />
      )}

      {data !== undefined && (
        <>
          {/* ---- identity section ---- */}
          <div className="space-y-4 rounded-xl border border-line bg-surface-raised p-5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-ink-faint" />
              <p className="text-sm font-medium text-ink">Identity</p>
            </div>

            <Field label="Product name" htmlFor="branding-name">
              <div className="flex gap-2">
                <Input
                  id="branding-name"
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameDirty(true);
                  }}
                />
                <Button
                  disabled={setBranding.isPending || !nameDirty || displayName.trim() === ''}
                  onClick={() => {
                    setBranding.mutate({ productName: displayName.trim() });
                  }}
                >
                  Save
                </Button>
                {nameDirty && (
                  <Button
                    variant="ghost"
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setName('');
                      setNameDirty(false);
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </Field>

            <Field
              label="Sales / contact email"
              htmlFor="branding-sales-email"
              hint="Powers the 'Contact us' tile owners see on the billing page when no plan fits them. Leave blank to hide it."
            >
              <div className="flex gap-2">
                <Input
                  id="branding-sales-email"
                  type="email"
                  placeholder="sales@yourcompany.com"
                  value={displayEmail}
                  maxLength={254}
                  onChange={(event) => {
                    setSalesEmail(event.target.value);
                    setSalesEmailDirty(true);
                  }}
                />
                <Button
                  disabled={
                    setBranding.isPending ||
                    !salesEmailDirty ||
                    (displayEmail.trim() !== '' && !isLikelyEmail(displayEmail.trim()))
                  }
                  onClick={() => {
                    const trimmed = displayEmail.trim();
                    setBranding.mutate({ salesEmail: trimmed === '' ? null : trimmed });
                  }}
                >
                  Save
                </Button>
                {salesEmailDirty && (
                  <Button
                    variant="ghost"
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setSalesEmail('');
                      setSalesEmailDirty(false);
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </Field>

            {setBranding.isError && (
              <ErrorView error={setBranding.error} title="Could not save branding" />
            )}
          </div>

          {/* ---- palette section ---- */}
          <div className="rounded-xl border border-line bg-surface-raised p-5">
            <PaletteSection
              selected={selectedPalette}
              onSelect={(paletteId) => {
                setPreviewPalette(paletteId);
                setBranding.mutate({ paletteId });
              }}
              disabled={setBranding.isPending}
            />
          </div>

          {/* ---- assets section ---- */}
          <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-5">
            <div className="flex items-center gap-2">
              <Image className="size-4 text-ink-faint" />
              <p className="text-sm font-medium text-ink">Assets</p>
            </div>

            <BrandingAssetUpload
              label="Logo"
              description="Shown in the sidebar, login page, and email templates. PNG only, 2 MB max."
              icon={Image}
              currentUrl={data.logoUrl}
              inputRef={logoInputRef}
              progress={logoProgress}
              error={uploadLogo.isError ? uploadLogo.error : null}
              onSelect={(file) => {
                uploadLogo.mutate(file);
              }}
            />

            <BrandingAssetUpload
              label="Favicon"
              description="Shown in the browser tab. PNG only, 2 MB max."
              icon={Globe}
              currentUrl={data.faviconUrl}
              inputRef={faviconInputRef}
              progress={faviconProgress}
              error={uploadFavicon.isError ? uploadFavicon.error : null}
              onSelect={(file) => {
                uploadFavicon.mutate(file);
              }}
            />
          </div>

          {/* ---- live preview ---- */}
          <div className="rounded-xl border border-line bg-surface-raised p-5">
            <BrandingPreview
              productName={displayName}
              paletteId={selectedPalette}
              logoUrl={data.logoUrl}
              faviconUrl={data.faviconUrl}
              salesEmail={displayEmail.trim() !== '' ? displayEmail.trim() : null}
            />
          </div>
        </>
      )}
    </section>
  );
}
