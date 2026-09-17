import { AlertTriangle, Settings, LogOut, X } from 'lucide-react';
import { useMaintenanceStore } from '../lib/maintenance-store.js';
import { signOut, useSession } from '../lib/session.js';
import { cn } from '../lib/cn.js';

/**
 * A persistent, premium maintenance-mode banner.
 *
 * Used on the login page (bare layout) — sits at the top of the page so the
 * user can still reach the sign-in form below it.
 */
export function MaintenanceBanner() {
  const active = useMaintenanceStore((s) => s.active);
  const message = useMaintenanceStore((s) => s.message);
  const dismissed = useMaintenanceStore((s) => s.dismissed);
  const dismiss = useMaintenanceStore((s) => s.dismiss);

  if (!active || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'relative flex items-start gap-3 border-b px-4 py-3',
        'border-amber-300/40 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-100',
      )}
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        strokeWidth={2}
      />
      <p className="flex-1 text-[13px] font-medium leading-relaxed">
        {message || 'System is currently under maintenance. Please check back shortly.'}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss maintenance notice"
        className="shrink-0 rounded p-0.5 text-amber-600/70 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400/70 dark:hover:bg-amber-900 dark:hover:text-amber-200"
      >
        <X aria-hidden="true" className="size-4" strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Full-page maintenance screen for authenticated users.
 *
 * When maintenance mode is on and the user is signed in, this replaces the
 * entire app content. Shows the operator-set message and a sign-out button.
 * Platform operators can navigate directly to /platform-admin to disable it.
 */
export function MaintenanceScreen() {
  const active = useMaintenanceStore((s) => s.active);
  const message = useMaintenanceStore((s) => s.message);
  const status = useSession((s) => s.status);

  /* Not signed in yet — the login page handles its own banner. */
  if (status !== 'authenticated') return null;
  if (!active) return null;

  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface px-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        {/* Icon */}
        <div className="relative">
          <div className="flex size-20 items-center justify-center rounded-3xl bg-linear-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30">
            <Settings
              aria-hidden="true"
              className="size-10 text-amber-600 dark:text-amber-400"
              strokeWidth={1.5}
            />
          </div>
          {/* Subtle pulse ring */}
          <div className="absolute inset-0 animate-pulse rounded-3xl ring-2 ring-amber-400/20 dark:ring-amber-500/20" />
        </div>

        {/* Text */}
        <div className="space-y-3">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Scheduled Maintenance
          </h1>
          <p className="text-base leading-relaxed text-ink-muted">
            {message || "We're currently performing maintenance. Please check back shortly."}
          </p>
        </div>

        {/* Sign out */}
        <button
          type="button"
          onClick={() => {
            void signOut().then(() => {
              window.location.assign('/login');
            });
          }}
          className="flex items-center gap-2 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          <LogOut aria-hidden="true" className="size-4" strokeWidth={2} />
          Sign out
        </button>
      </div>
    </div>
  );
}
