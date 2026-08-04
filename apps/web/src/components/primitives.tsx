import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';

/**
 * The primitives this app actually uses.
 *
 * PLAN.md §6 is explicit that `packages/ui` must NOT be built speculatively:
 * "extract a component only once the same pattern appears three times in Phase
 * 3. A design system built before it has consumers is a reliable time sink."
 *
 * So these live here, in the app, until that threshold is met. Radix supplies
 * the primitives with real behaviour — focus traps, roving tabindex, escape
 * handling — and these are the styled shells around them plus the handful of
 * things Radix has no opinion about.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
  secondary: 'bg-surface-raised text-ink border border-line hover:bg-surface-hover',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink',
  danger: 'bg-danger text-danger-ink hover:opacity-90',
};

const BUTTON_SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-9 px-3 text-sm gap-1.5',
};

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      /* Explicit, because the HTML default is `submit`. A styled button inside a
         form that was only meant to open a menu otherwise submits the form —
         which in this app means saving a half-edited card. */
      type={type ?? 'button'}
      className={cn(
        'inline-flex items-center justify-center rounded font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/* `ComponentProps`, not `ComponentPropsWithoutRef`: React 19 passes `ref` as an
   ordinary prop, and `FocusOnMountInput` below needs to forward one. */
export type InputProps = ComponentProps<'input'>;

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded border border-line bg-surface-sunken px-2.5 text-sm text-ink',
        'placeholder:text-ink-faint focus:border-accent focus:outline-none',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

/**
 * An input that takes focus when it appears.
 *
 * Not `autoFocus`. That prop moves focus on MOUNT regardless of why the element
 * appeared — on a page load it relocates a screen reader user without their
 * asking, which is why `jsx-a11y/no-autofocus` flags it. Focusing in an effect
 * is the same DOM call made deliberately, and it is only correct where the
 * element appeared BECAUSE of something the user just did: the inline-edit input
 * in the table view, which replaces the cell they double-clicked. If the control
 * would be there anyway, it should not steal focus at all.
 */
export function FocusOnMountInput({ className, ...props }: InputProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return <Input ref={ref} className={className} {...props} />;
}

export type TextareaProps = ComponentPropsWithoutRef<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'w-full rounded border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink',
        'placeholder:text-ink-faint focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export interface FieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}

/**
 * A labelled form control.
 *
 * The error is wired with `aria-describedby` by the caller passing the same id;
 * a validation message that is only red text is invisible to a screen reader,
 * which means the form is unusable rather than merely unattractive.
 */
export function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
      {hint !== undefined && error === undefined && (
        <p className="text-xs text-ink-faint">{hint}</p>
      )}
      {error !== undefined && (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export interface BadgeProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}

export function Badge({ children, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        'bg-surface-hover text-ink-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Hues an avatar can take, spread around the wheel.
 *
 * Chosen from the id rather than from a counter, so the same person is the same
 * colour on every board and in every list — which is the only property that
 * makes a colour worth having. A per-render counter would recolour everyone the
 * moment one card was filtered out.
 */
const AVATAR_HUES = [12, 45, 92, 150, 196, 258, 302, 334] as const;

function hueOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    /* An ordinary string hash, and deliberately not from @taskflow/security: this
       picks a colour. Reaching for a CSPRNG here would say the choice is
       security-relevant, and it also has to be STABLE, which a random source is
       not. */
    hash = (hash * 31 + id.charCodeAt(index)) % 1_000_003;
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? 258;
}

/**
 * Initials for a label that is usually an email address.
 *
 * `tenancy.members.list` returns `email` and no display name (there is no
 * profile surface yet), so the local part is all there is to work with.
 * `ada.lovelace@x.com` gives AL, `ada@x.com` gives AD — two characters either
 * way, because a stack of avatars that are sometimes one character wide and
 * sometimes two does not line up.
 */
function initialsOf(label: string): string {
  const local = (label.split('@')[0] ?? label).trim();
  const parts = local.split(/[._\-+\s]+/u).filter((part) => part.length > 0);

  const first = parts[0] ?? label;
  const second = parts[1];

  const initials =
    second === undefined ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`;

  return initials.toUpperCase() || '?';
}

export interface AvatarProps {
  readonly userId: string;
  /** Email or display name. Shown on hover and to assistive tech. */
  readonly label: string;
  readonly size?: 'xs' | 'sm';
  readonly className?: string;
}

/**
 * A person, as a coloured disc.
 *
 * `role="img"` with an `aria-label` rather than a bare styled span: the initials
 * inside are a rendering of the label, not text worth reading out, and without
 * the role a screen reader announces "AL" — which identifies nobody.
 */
export function Avatar({ userId, label, size = 'sm', className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ backgroundColor: `oklch(58% 0.13 ${String(hueOf(userId))})` }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white',
        'ring-1 ring-surface-raised',
        size === 'xs' ? 'size-5 text-[9px]' : 'size-6 text-[10px]',
        className,
      )}
    >
      {initialsOf(label)}
    </span>
  );
}

/**
 * Overlapping avatars with an overflow count.
 *
 * The overflow badge carries the remaining NAMES in its title, because "+3" that
 * cannot be resolved to people is a decoration. Capped rather than scrollable —
 * a card tile is not the place to enumerate a team.
 */
export function AvatarStack({
  people,
  max = 3,
  size = 'xs',
}: {
  readonly people: readonly { userId: string; label: string }[];
  readonly max?: number;
  readonly size?: 'xs' | 'sm';
}) {
  if (people.length === 0) return null;

  const shown = people.slice(0, max);
  const hidden = people.slice(max);

  return (
    <span className="flex items-center -space-x-1">
      {shown.map((person) => (
        <Avatar key={person.userId} userId={person.userId} label={person.label} size={size} />
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map((person) => person.label).join(', ')}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full',
            'bg-surface-hover text-ink-muted ring-1 ring-surface-raised',
            size === 'xs' ? 'size-5 text-[9px]' : 'size-6 text-[10px]',
          )}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent',
        className,
      )}
    />
  );
}

/**
 * A loading placeholder shaped like the thing that is loading.
 *
 * Preferred over `Spinner` for any region whose shape is known in advance, which
 * is most of this app: a board has columns, a table has rows, a card panel has
 * sections. A centred spinner on an otherwise empty page communicates "busy"
 * and nothing else, and at the moment it disappears the layout jumps into
 * existence — so every load reads as a reflow rather than as content arriving.
 *
 * `Spinner` stays for the cases where the shape genuinely is not known: a button
 * mid-submit, and the boot gate before the app knows what it is rendering.
 *
 * `aria-hidden` and no `role="status"` on purpose. The REGION announces its own
 * busy state via `aria-busy` on the container; a skeleton that also announced
 * itself would read out one "Loading" per grey rectangle, which is how a
 * fourteen-row table becomes fourteen announcements.
 */
export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-pulse rounded bg-surface-hover', className)}
    />
  );
}

/** Stacked skeleton lines, for a list whose row height is known. */
export function SkeletonRows({
  rows = 5,
  className,
}: {
  readonly rows?: number;
  readonly className?: string;
}) {
  return (
    <div aria-busy="true" className={cn('space-y-2', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The empty state for a list that loaded successfully and has nothing in it.
 *
 * Distinct from an error and from a spinner on purpose. Rendering nothing for
 * all three makes "you have no projects", "the request failed", and "still
 * loading" indistinguishable, and the user's next action differs in each case.
 */
export function Empty({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded border border-dashed border-line p-8 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description !== undefined && <p className="text-xs text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Settings layout
 *
 * These three arrived by the §6 rule rather than ahead of it: `Section` is used
 * eight times across the org and project settings pages, `AddPanel` four, and
 * `ConfirmButton` five. Each existed first as copied markup in one file, and was
 * lifted only once a second file needed the same thing.
 * -------------------------------------------------------------------------- */

/**
 * A titled block, with an optional count and description.
 *
 * Exists because the heading markup was duplicated eight times and had already
 * drifted: two spacing rhythms, and sections that silently lacked a description.
 */
export function Section({
  title,
  count,
  description,
  children,
}: {
  readonly title: string;
  /* `| undefined` explicitly, not just `?`. Under `exactOptionalPropertyTypes`
     an optional prop rejects an explicitly-passed `undefined`, and callers pass
     `data?.length` — which is exactly that while the query is loading. */
  readonly count?: number | undefined;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{title}</h2>
        {count !== undefined && <Badge>{count}</Badge>}
      </div>
      {description !== undefined && <p className="text-xs text-ink-muted">{description}</p>}
      {children}
    </section>
  );
}

/**
 * The bordered block an "add" control sits in.
 *
 * Dashed and sunken so the top of a list reads as a control rather than as the
 * collection's first item — which is the risk of putting the form above the
 * list, and the reason it is worth putting there anyway: a form BELOW forty rows
 * moves further away the more the page is used.
 */
export function AddPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface-sunken/60 p-3">
      {children}
    </div>
  );
}

/**
 * A destructive action that takes two clicks.
 *
 * Not `window.confirm`: that dialog is unstyleable, blocks the whole tab, and
 * users dismiss it reflexively. Revealing the confirmation in place means the
 * second click is on a different, differently-labelled control than the first,
 * and clicking anywhere else cancels rather than confirming.
 *
 * `confirmLabel` is separate from `label` so the caller can state the BLAST
 * RADIUS at the moment it matters — "Delete from 12 cards" is a different
 * decision from "Delete", and the count is only known per row.
 *
 * Reserved for genuinely irreversible actions. Archiving is NOT one: it has
 * Restore beside it, and a confirm on something already undoable is the noise
 * that trains people to click through the confirms that matter.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
  size = 'sm',
  className,
}: {
  readonly label: string;
  readonly confirmLabel?: string;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly size?: ButtonSize;
  readonly className?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        size={size}
        variant="ghost"
        className={cn('text-ink-faint hover:text-danger', className)}
        disabled={disabled}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {label}
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        size={size}
        variant="ghost"
        className="text-danger"
        disabled={disabled}
        onClick={() => {
          onConfirm();
          setConfirming(false);
        }}
      >
        {confirmLabel ?? `Confirm ${label.toLowerCase()}`}
      </Button>
      <Button
        size={size}
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}
