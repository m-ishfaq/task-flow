import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';
import { TaskFlowLogo } from '../../components/taskflow-logo.js';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import { paletteColorsOf } from '../../lib/branding-palettes.js';
import { Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StepUpGate } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Branding
 * -------------------------------------------------------------------------- */

/**
 * Platform-wide branding (migration 0073) — product name, an accent palette
 * chosen from a curated set (never a free color picker; see
 * `apps/api/src/platform-admin/branding.service.ts`'s own header on why),
 * and a logo/favicon upload.
 *
 * The logo/favicon flow is the same three steps `AttachmentSection` uses —
 * presign, PUT directly to storage, confirm — and the same rule applies:
 * never treat a successful PUT as done. The verdict comes from `confirm`,
 * which is also the only place the row actually changes; a rejected or
 * infected upload leaves whatever was there before untouched.
 */

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
  /* Pending palette selection for the live preview — tracks what the user has
     chosen but not yet saved, so the preview updates instantly. */
  const [previewPalette, setPreviewPalette] = useState<string | null>(null);

  const brandingQuery = useQuery({
    queryKey: keys.platformBranding(),
    queryFn: async () => wire(await api.platformAdmin.branding.get.query(undefined)),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.platformBranding() });

  const setBranding = useMutation({
    mutationFn: (input: {
      productName?: string;
      paletteId?: PaletteId;
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

  return (
    <section aria-label="Branding" className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        One brand for this whole deployment — every organization sees the same name, logo, and
        accent color. There is no per-org override.
      </p>

      {brandingQuery.isPending && <SkeletonRows rows={4} className="*:h-12" />}
      {brandingQuery.isError && (
        <ErrorView error={brandingQuery.error} title="Could not load branding" />
      )}

      {data !== undefined && (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-line p-5">
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

            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <p className="text-xs font-medium text-ink">Accent palette</p>
                {previewPalette !== null && previewPalette !== data.paletteId && (
                  <button
                    type="button"
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setPreviewPalette(null);
                    }}
                    className="text-[11px] text-accent underline underline-offset-2 hover:text-accent/80"
                  >
                    Reset to {data.paletteId}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {PALETTE_IDS.map((paletteId) => (
                  <button
                    key={paletteId}
                    type="button"
                    title={paletteId}
                    aria-label={`Use the ${paletteId} palette`}
                    aria-pressed={(previewPalette ?? data.paletteId) === paletteId}
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setPreviewPalette(paletteId);
                      setBranding.mutate({ paletteId });
                    }}
                    className={cn(
                      'size-8 rounded-full border-2 transition-transform',
                      (previewPalette ?? data.paletteId) === paletteId
                        ? 'scale-110 border-ink ring-2 ring-accent/30'
                        : 'border-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: paletteColorsOf(paletteId).base }}
                  />
                ))}
              </div>
            </div>

            {setBranding.isError && (
              <ErrorView error={setBranding.error} title="Could not save branding" />
            )}
          </div>

          <BrandingPreview
            productName={displayName}
            paletteId={previewPalette ?? data.paletteId}
            logoUrl={data.logoUrl}
            faviconUrl={data.faviconUrl}
          />

          <BrandingAssetUpload
            label="Logo"
            description="Shown in the sidebar. PNG only, 2 MB max."
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
            currentUrl={data.faviconUrl}
            inputRef={faviconInputRef}
            progress={faviconProgress}
            error={uploadFavicon.isError ? uploadFavicon.error : null}
            onSelect={(file) => {
              uploadFavicon.mutate(file);
            }}
          />
        </>
      )}
    </section>
  );
}

function BrandingAssetUpload({
  label,
  description,
  currentUrl,
  inputRef,
  progress,
  error,
  onSelect,
}: {
  readonly label: string;
  readonly description: string;
  readonly currentUrl: string | null;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly progress: string | null;
  readonly error: unknown;
  readonly onSelect: (file: File) => void;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-line p-4 transition-colors hover:bg-surface-hover/20">
      <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-sunken">
        {currentUrl !== null ? (
          <img src={currentUrl} alt="" className="max-h-full max-w-full rounded object-contain" />
        ) : label === 'Logo' ? (
          <TaskFlowLogo size={28} className="text-accent" />
        ) : (
          <TaskFlowLogo size={20} className="text-accent" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-[11px] text-ink-faint">{description}</p>
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
        {progress ?? 'Upload'}
      </Button>
    </div>
  );
}

/**
 * A live preview of the branding changes — shows how the sidebar, a page
 * header, and a sample card will look with the current name, palette, and
 * logo applied. Updates instantly as the operator edits.
 */
function BrandingPreview({
  productName,
  paletteId,
  logoUrl,
  faviconUrl,
}: {
  readonly productName: string;
  readonly paletteId: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
}) {
  const colors = paletteColorsOf(paletteId);

  return (
    <div className="rounded-xl border border-line bg-surface-sunken/40 p-4">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        Live preview
      </p>

      {/* Browser tab preview */}
      <div className="mb-3 overflow-hidden rounded-lg border border-line bg-surface-raised">
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1">
            {faviconUrl !== null ? (
              <img src={faviconUrl} alt="" className="size-3 shrink-0 rounded-sm object-contain" />
            ) : (
              <TaskFlowLogo size={12} className="shrink-0 text-accent" />
            )}
            <span className="max-w-30 truncate text-[10px] text-ink">
              {productName || 'TaskFlow'}
            </span>
            <span className="ml-0.5 text-ink-faint">×</span>
          </div>
          <div className="flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5">
            {/* A real glyph, not a 🔒 emoji — same reasoning as every other
                emoji-as-icon fix in this pass: it renders at the OS's own
                size/weight and never matches this app's icon language. */}
            <Lock
              aria-hidden="true"
              className="size-2.5 shrink-0 text-ink-faint"
              strokeWidth={2.5}
            />
            <span className="max-w-25 truncate text-[9px] text-ink-muted">
              app.{(productName || 'taskflow').toLowerCase().replace(/\s+/g, '-')}.io/home
            </span>
          </div>
        </div>
        <div className="flex h-10 items-center px-3">
          <span className="text-[10px] text-ink-faint">Page content…</span>
        </div>
      </div>

      <div className="flex gap-3">
        {/* Mini sidebar */}
        <div className="flex w-40 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-raised">
          <div className="flex h-9 items-center gap-1.5 border-b border-line px-2.5">
            {logoUrl !== null ? (
              <img src={logoUrl} alt="" className="size-4 shrink-0 rounded object-contain" />
            ) : (
              <TaskFlowLogo size={16} className="shrink-0 text-accent" />
            )}
            <span className="truncate text-[11px] font-semibold text-ink">
              {productName || 'TaskFlow'}
            </span>
          </div>
          <nav className="flex flex-col gap-0.5 p-1.5">
            {['My tasks', 'Chat', 'Docs', 'People'].map((item, index) => (
              <span
                key={item}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]',
                  index === 0 ? 'bg-accent/10 font-medium text-accent' : 'text-ink-muted',
                )}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: index === 0 ? colors.base : 'transparent' }}
                />
                {item}
              </span>
            ))}
          </nav>
        </div>

        {/* Mini page content */}
        <div className="min-w-0 flex-1 space-y-2.5">
          {/* Mini header */}
          <div className="flex items-center justify-between rounded-lg border border-line bg-surface-raised px-3 py-2">
            <span className="text-[11px] font-semibold text-ink">Projects</span>
            <span
              className="rounded-md px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: colors.base }}
            >
              New project
            </span>
          </div>

          {/* Mini card */}
          <div className="rounded-lg border border-line bg-surface-raised p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: colors.base }} />
              <span className="text-[10px] font-medium text-ink">Sample card</span>
            </div>
            <p className="text-[10px] text-ink-muted">
              This is how cards will look with your brand accent.
            </p>
            <div className="mt-1.5 flex gap-1">
              <span
                className="rounded-md px-1 py-0.5 text-[9px] font-medium"
                style={{ backgroundColor: `${colors.base}20`, color: colors.base }}
              >
                In progress
              </span>
              <span className="rounded-md bg-surface-hover px-1 py-0.5 text-[9px] text-ink-faint">
                Design
              </span>
            </div>
          </div>

          {/* Color swatches */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-faint">Accent:</span>
            <span className="size-3 rounded-full" style={{ backgroundColor: colors.base }} />
            <span className="size-3 rounded-full" style={{ backgroundColor: colors.hover }} />
            <span className="text-[10px] text-ink-faint">• {paletteId}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
