import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Search, X } from 'lucide-react';
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

/**
 * `primary` carries the only elevation on a Button — a permanent `shadow-sm`
 * (resolving through `styles.css`'s `@theme` override of Tailwind's own
 * shadow tokens, not a bespoke value) — because it is the one variant making
 * a claim to be THE action on its surface; giving every variant a shadow
 * would just make the page noisier, not clearer. A bigger shadow on HOVER
 * was tried and cut: `--shadow-lg` is tuned for Popover/Modal-sized panels,
 * and jumping to it on a `h-9` button read as the button floating rather
 * than lifting. The hover/press feedback stays where it already read
 * correctly — `bg-accent-hover` and the `press` class's active-state scale
 * (`styles.css`). `secondary` and `danger` stay flat, matching their
 * border-defined shape; `ghost` never had a shape to raise in the first
 * place.
 */
const BUTTON_VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  /* The inset white ring is the machined edge real SaaS buttons have — a
     flat colour block on a dark surface reads as a sticker, and a hairline
     highlight along the top edge is what makes it read as a physical
     control. On the accent fill it is nearly invisible, which is the point:
     it is a boundary, not a decoration. */
  /* The glow is `color-mix()` against `--color-accent`, not a literal
     `oklch(.. 285)` — a literal hue here stayed indigo regardless of an
     org's chosen branding palette (`BrandingProvider` only ever overrides
     `--color-accent`/`-hover`/`-ink`), the highest-visibility instance of
     the "palette only half applies" defect fixed alongside this one; see
     `styles.css`'s `--color-accent-strong` comment for the rest. */
  primary:
    'bg-accent text-accent-ink shadow-[0_2px_8px_color-mix(in_oklab,var(--color-accent)_30%,transparent)] ring-1 ring-inset ring-white/10 hover:bg-accent-hover hover:shadow-[0_4px_12px_color-mix(in_oklab,var(--color-accent)_40%,transparent)]',
  /* `shadow-top-light` composed alongside the existing flat `shadow-sm` via
     an arbitrary value (Tailwind utilities can't be layered — the last
     `shadow-*` class simply wins, since they all set the same property) —
     the Design Bible's "machined top-edge" highlight (§03), so a secondary
     button reads as a raised, physical control the same way `primary`'s own
     ring already does, rather than a flat colour block. */
  secondary:
    'bg-surface-raised text-ink border border-line/60 shadow-[var(--shadow-sm),var(--shadow-top-light)] hover:bg-surface-hover hover:border-line-strong',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink',
  danger:
    'bg-danger text-danger-ink shadow-sm ring-1 ring-inset ring-white/10 hover:bg-danger/90 hover:shadow-[0_2px_8px_oklch(55%_0.19_22/30%)]',
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
        /* `rounded-lg` (8px), not the bare `rounded` (4px) this used to be —
           every other raised control in the app (Input, the card tile, the
           board's segmented view toggle) already sits at 8-11px, and a
           button at a quarter of that read as a sharper, flatter corner than
           everything around it. The Design Bible's own component kit (§components)
           puts every button at 9px; 8px is the nearest step this app's
           existing radius scale already has, so this is the one component
           that needed to move, not a new radius token. */
        'press inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/**
 * A segmented control — one of a small, fixed set of mutually exclusive
 * choices, rendered as a pill-shaped button group. The Design Bible's
 * `.segmented`/`.tabs-demo` pattern (board view toggle, the component kit's
 * own tab demo), extracted here per PLAN.md §6 once the identical markup
 * had drifted into two independent copies — the board's view toggle
 * (`board-page.tsx`) and the home page's sprint-scope filter
 * (`home-page.tsx`) — with slightly different padding, borders and no
 * shared shadow, which is exactly the kind of divergence a shared
 * component exists to stop compounding as a third caller inevitably
 * copies whichever one it happened to find first.
 *
 * Generic over the option type so a caller's own union (board's
 * `'board' | 'table' | ...`, home's `'all' | 'sprint' | 'backlog'`) is what
 * `value`/`onChange` are typed against — never a bare `string`, which would
 * let a typo in one call site's `value` compile silently.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
}: {
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly options: readonly { readonly value: T; readonly label: ReactNode }[];
  readonly 'aria-label': string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 gap-0.5 rounded-lg border border-line/60 bg-surface-sunken/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-(--motion-fast)',
            value === option.value
              ? 'bg-accent text-accent-ink shadow-sm'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* `ComponentProps`, not `ComponentPropsWithoutRef`: React 19 passes `ref` as an
   ordinary prop, and `FocusOnMountInput` below needs to forward one. */
export type InputProps = ComponentProps<'input'>;

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-line/50 bg-surface-sunken px-3 text-sm text-ink transition-all',
        /* `focus:bg-surface` — a step lighter than the resting `surface-sunken`
           — is the "considered" touch here: a field that visibly comes
           forward when it takes focus. A soft `ring-2` at 25% accent is the
           same glow the focused select gets, so every form control in the
           app announces focus the same way; it sits OUTSIDE the border where
           the global `:focus-visible` outline lives, so the two do not
           collide — and `:focus-visible` never fires for a mouse click
           anyway, which is the case this ring is for. */
        'placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 focus:outline-none',
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

/**
 * The one search box every long list in this app should reach for, instead of
 * each surface growing its own copy of "a bare `Input` above a filter" — a
 * pattern that had genuinely drifted three separate ways (channel-details.tsx's
 * member roster, settings-page.tsx's member list, and every new list this
 * pass added) before this existed. A leading `Search` glyph and a clear
 * button once there is something to clear are the two things a plain
 * `<Input placeholder="Search…">` never had, and are most of what made a
 * long, unfiltered list read as "cheap" in the first place — a control that
 * announces what it does at a glance, not a label doing all the work.
 *
 * Deliberately a controlled `value`/`onChange(string)` pair, not a raw input
 * event, since every caller only ever wants the string.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
  'aria-label': ariaLabel,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
}) {
  return (
    <div className={cn('relative h-9', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint"
        strokeWidth={2}
      />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-full w-full rounded-lg border border-line/50 bg-surface-sunken pr-8 pl-8 text-sm text-ink transition-all placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 focus:outline-none"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
          }}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-ink-faint transition-colors hover:text-ink"
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export type TextareaProps = ComponentPropsWithoutRef<'textarea'>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        'w-full rounded-lg border border-line/50 bg-surface-sunken px-3 py-2 text-sm text-ink transition-all',
        /* Same reasoning as Input's `focus:bg-surface` above. */
        'placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 focus:outline-none',
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
 *
 * ## Laying these out in a ROW
 *
 * The three parts stack, so a Field carrying a hint or an error is TALLER than
 * one that is not — which makes `items-end` the wrong choice for a horizontal
 * row, even though it is the intuitive one. Aligning bottom edges puts a
 * hintless field's input level with its neighbour's hint text, one line below
 * where it looks like it belongs, and the row only goes crooked once a hint
 * appears.
 *
 * Use `items-start` instead: every label is one line of `text-xs`, so the
 * controls line up on their own and the hints hang off the bottom without
 * moving anything. Bare controls in the same row (a submit button, a checkbox)
 * carry `mt-5` to drop past the label — 1rem of label plus `space-y-1`.
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

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

/**
 * One color combination per tone, matching the Design Bible's component-kit
 * badge variants (`.bd.n/.ok/.wn/.er/.ac`) — a tint of the state color at low
 * opacity behind text in that same color, no border except on `neutral`
 * (whose fill alone is too close to the surface to read as a shape without
 * one). Kept at `rounded-md` (6px) rather than the bible's pill-shaped
 * `.bd` (`border-radius: 999px`): every real Badge call site in this app is
 * a label or count sitting inline with other 6px-radius metadata (a card's
 * tags, a section heading's count) — the bible's OWN card-metadata tags
 * (`.tag`) are 6px for the identical reason, and a pill-shaped badge would
 * be the one rounder shape on an otherwise consistently-6px row.
 */
const BADGE_TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-surface-hover/80 text-ink-muted border border-line/30',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  accent: 'bg-accent/15 text-accent',
};

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly title?: string;
}

export function Badge({ children, tone = 'neutral', className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        /* `text-xs`, not the 11px this used to be. 11px is below the floor the
           UI/UX redesign pass sets for anything a person reads by scanning —
           badge text was the single most common 11px offender (292 instances
           of 9-11px across the app), and a count or a role label is read far
           more often than it is decorative. The slightly larger footprint is
           the same 12px the board's other metadata uses, so badges sit level
           with their neighbours rather than one size down from them. */
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
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
  /** `lg` (52px) is the Design Bible's own `.pc .a` — a profile CARD's own
      identity mark (People's directory grid), not a list row's. */
  readonly size?: 'xs' | 'sm' | 'lg';
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
  const hue = hueOf(userId);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      /* A two-stop gradient at the person's own hue, not a flat fill — the
         Design Bible's own avatar discs (`.me`, `.dial-face .a`, `.msg .a`,
         `.p-msg .a`) are all `linear-gradient(160deg, <light>, <dark>)`
         rather than one flat color, which is what gives every "person as a
         disc" in the bible's mockups a slight dimensional lift instead of a
         sticker-flat fill. Kept at the previously-audited hue/chroma pair
         (58% 0.13) as the gradient's MIDPOINT — 64%/52% either side of it —
         so the disc's overall weight against the surrounding surfaces is
         unchanged from before this ran. */
      style={{
        backgroundImage: `linear-gradient(160deg, oklch(64% 0.13 ${String(hue)}), oklch(52% 0.13 ${String(hue)}))`,
      }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white',
        'ring-1 ring-surface-raised',
        /* 10/11px initials, not the 9/10px this used to be — two characters in
           9px on a 20px disc are a smudge, and initials are the identifier a
           stack of avatars is scanned by. `lg` is a real 52px, `.pc .a`'s own
           value — not a Tailwind step (48/56), an arbitrary one matching the
           bible exactly rather than the nearest round number. */
        size === 'xs'
          ? 'size-5 text-[10px]'
          : size === 'lg'
            ? 'size-13 text-[17px]'
            : 'size-6 text-[11px]',
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
  className,
}: {
  readonly people: readonly { userId: string; label: string }[];
  readonly max?: number;
  readonly size?: 'xs' | 'sm';
  readonly className?: string;
}) {
  if (people.length === 0) return null;

  const shown = people.slice(0, max);
  const hidden = people.slice(max);

  return (
    <span className={cn('flex items-center -space-x-1', className)}>
      {shown.map((person) => (
        <Avatar key={person.userId} userId={person.userId} label={person.label} size={size} />
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map((person) => person.label).join(', ')}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full',
            'bg-surface-hover text-ink-muted ring-1 ring-surface-raised',
            size === 'xs' ? 'size-5 text-[10px]' : 'size-6 text-[11px]',
          )}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

/**
 * An organization, as a small colored square — the Design Bible's own
 * `.org-badge` (§app-frame), which the org switcher had none of at all
 * before this: a plain text name with no identity mark next to it, unlike
 * every PERSON in this app, which always renders as a colored disc.
 *
 * Square (`rounded-md`), not round — the one deliberate shape difference
 * from `Avatar`, so an org reads as a distinct kind of thing from a person
 * at a glance in the same switcher menu, the way a folder icon reads
 * differently from a file icon. Hue is hashed from the org's own id (same
 * `hueOf` an avatar uses), not the bible's own fixed people-hue example —
 * the mockup only ever shows one org, so it had no reason to vary; a real
 * switcher lists several, and a per-org color is what actually lets someone
 * tell two rows apart at a glance the way `Avatar`'s per-person color does.
 */
export function OrgBadge({
  orgId,
  name,
  className,
}: {
  readonly orgId: string;
  readonly name: string;
  readonly className?: string;
}) {
  const hue = hueOf(orgId);
  return (
    <span
      aria-hidden="true"
      style={{
        backgroundImage: `linear-gradient(160deg, oklch(64% 0.13 ${String(hue)}), oklch(52% 0.13 ${String(hue)}))`,
      }}
      className={cn(
        'inline-flex size-5.5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white',
        className,
      )}
    >
      {initialsOf(name)}
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
 *
 * The redesign pass's version: an optional icon in a ringed disc (the same
 * container the app uses for its other lone-glyph moments), a larger
 * max-width'd description, and a touch more vertical room. An empty state is
 * where a product has the most freedom to look designed, because nothing is
 * competing with it — a bare dashed box reads as "unfinished", which is the
 * exact impression a demo with no data leaves.
 *
 * The faint accent glow behind the icon is the Design Bible's own `.empty`
 * signature (§components) — a `radial-gradient` at 7% accent opacity,
 * centred above the content rather than filling the whole box, so the panel
 * reads as lit from one considered point rather than tinted flat. It costs
 * nothing when there's no icon to glow behind (the gradient is still there,
 * just under nothing but whitespace) so it stays on unconditionally rather
 * than being gated on `icon !== undefined`.
 */
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  /** A lone glyph above the title — the same "icon in a disc" shape the app uses elsewhere. */
  readonly icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong/60 bg-[radial-gradient(420px_200px_at_50%_0%,color-mix(in_oklab,var(--color-accent)_7%,transparent),transparent_70%)] bg-surface-sunken/30 p-12 text-center">
      {icon !== undefined && (
        <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-surface-raised text-ink-faint ring-1 ring-line/50">
          {icon}
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description !== undefined && (
        <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-1">{action}</div>}
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
 * The outer wrapper every ordinary content page (a form, a list, a
 * dashboard) sits in — centred, one padding scale, one small set of
 * max-width tiers to pick from instead of a free-form string.
 *
 * Before this, every page hand-rolled its own outer `<div>`, and they had
 * drifted into at least six different combinations of padding (`p-4`, `p-6`,
 * `p-8`, `px-6 py-6`, `px-6 py-8`, a responsive `p-4 md:p-8`) and max-width
 * (`max-w-2xl` through `max-w-7xl`, one page carrying a literal one-off
 * `max-w-350` found nowhere else) — the same "assembled, not designed"
 * drift `PageHeader`'s own header already fixed once for heading typography,
 * recurring one level up at the page's own outer shape. `maxWidth` is a
 * closed set of named tiers, not an arbitrary string, for the identical
 * reason `PageHeader` itself is a component and not a repeated `<h1>` — a
 * new page reaches for one of four sizes instead of guessing a Tailwind
 * value that happens to look right.
 *
 * Deliberately NOT used by a panel-managed, full-height layout (the board
 * canvas, Chat, Docs' own editor) — those manage their own scrolling and
 * spacing because their content is not a simple top-to-bottom column, and
 * forcing a centred, padded box around them would break the real UI they
 * already have, not fix an inconsistency.
 */
export function PageContainer({
  maxWidth = 'xl',
  className,
  children,
}: {
  /** `md` = 42rem (a simple form), `lg` = 56rem, `xl` = 64rem (the default —
      most settings/list pages), `2xl` = 80rem (a wide table or dashboard). */
  readonly maxWidth?: 'md' | 'lg' | 'xl' | '2xl';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn('mx-auto w-full p-6', PAGE_CONTAINER_MAX_WIDTH[maxWidth], className)}>
      {children}
    </div>
  );
}

const PAGE_CONTAINER_MAX_WIDTH: Readonly<Record<'md' | 'lg' | 'xl' | '2xl', string>> = {
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-[85%]',
  '2xl': 'max-w-7xl',
};

/**
 * The page header — one pattern for every surface in the app.
 *
 * Before this, every page hand-rolled its own `h1 + p` block and they had
 * drifted into four different sizes and rhythms (`text-base`, `text-lg`, one
 * at `text-xl`), which is exactly how an app reads as "assembled" rather than
 * designed. One component, `font-display` (Geist) at `text-xl` like the login
 * page's own heading, description at `text-sm`, actions pinned right — the
 * same hierarchy Linear/ClickUp/Twilio use on every one of their pages.
 *
 * `icon` is optional and unused by every ordinary content page — a plain
 * `<h1>` is right for "Settings" or "Sprints". It exists for the handful of
 * pages that carry their own product identity the way the Design Bible's own
 * mockup gives the Assistant a mark next to its name (§12): a small solid
 * square, not the circular shape `Avatar`/`OrgBadge` already use for a
 * PERSON or an ORG, so a page's own brand mark reads as a third, distinct
 * kind of thing rather than colliding with either.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon !== undefined && (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-accent to-accent/70 text-white shadow-xs">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
          {description !== undefined && (
            <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-ink-muted">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * A titled block, with an optional count and description.
 *
 * Exists because the heading markup was duplicated eight times and had already
 * drifted: two spacing rhythms, and sections that silently lacked a description.
 *
 * The redesign pass moved the title off the ALL-CAPS micro-label (`text-xs
 * uppercase`) onto a sentence-case 13px heading. Uppercase micro-labels are
 * the visual signature of a default admin panel — real SaaS settings surfaces
 * (Linear, Twilio console, Stripe) set section titles in the same size and
 * weight as the content around them, one rung below the page title, and let
 * the type hierarchy carry the grouping instead of the tracking.
 */
export function Section({
  title,
  icon,
  count,
  description,
  children,
}: {
  readonly title: string;
  /**
   * An optional small tinted-square mark before the title, the same "icon
   * as identity" language `PageHeader`'s own icon slot already uses one
   * level up — a page gets a full gradient-filled square, a section inside
   * it gets a lighter, flat-tinted one, so the two read as a hierarchy
   * rather than two competing page-level marks stacked on top of each
   * other. Optional and additive: every existing caller with no icon
   * renders byte-for-byte as it did before this prop existed.
   */
  readonly icon?: ReactNode;
  /* `| undefined` explicitly, not just `?`. Under `exactOptionalPropertyTypes`
     an optional prop rejects an explicitly-passed `undefined`, and callers pass
     `data?.length` — which is exactly that while the query is loading. */
  readonly count?: number | undefined;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2.5">
        {icon !== undefined && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            {icon}
          </span>
        )}
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {count !== undefined && <Badge>{count}</Badge>}
      </div>
      {description !== undefined && (
        <p className="text-[13px] leading-relaxed text-ink-muted">{description}</p>
      )}
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
    <div className="rounded-xl border border-dashed border-line/50 bg-surface-sunken/40 p-4">
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

  /* `className` reaches BOTH states, not just the resting one. It used to be
     applied only to the pre-confirm button, so a caller that sized the control
     to fit a dense row got its sizing dropped the instant it was clicked — the
     row grew, and everything below it moved while the person was aiming at
     "Confirm". A confirmation that shifts its own target under the pointer is
     the one moment a size change costs the most. */
  return (
    <span className="flex items-center gap-1">
      <Button
        size={size}
        variant="ghost"
        className={cn('text-danger', className)}
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
        className={className}
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}
