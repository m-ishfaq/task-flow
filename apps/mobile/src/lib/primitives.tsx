import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, radiusCard } from '@taskflow/tokens';

/**
 * `apps/mobile`'s own shared primitive layer, built from zero
 * (`ai/design-rebuild-warm-dark.md` §4) — before this file, every screen
 * hand-rolled its own `Pressable`/`TextInput` styling by convention, a real
 * gap `avatar.tsx` and `skeleton.tsx` (both already real, adopted
 * primitives, kept where they already live) never covered. `Button`,
 * `TextField`, `Badge`, and `EmptyHint` below are each extracted from a
 * pattern found duplicated near-identically across real screens — most
 * directly `(auth)/sign-in.tsx`'s own button/input/link styles, and
 * `emptyHint`'s exact `{fontSize: 13, color: colors.inkFaint.hex}` pair,
 * found repeated in 9+ screens (people.tsx, permissions.tsx, org-settings.tsx,
 * project-settings/[projectId].tsx, docs-page/[pageId].tsx,
 * docs-space/[spaceId].tsx, (tabs)/calls.tsx, (tabs)/docs.tsx,
 * person/[userId].tsx) with only each screen's own spacing (margin/padding)
 * genuinely varying — not the shared pair itself.
 *
 * Deliberately NOT a port of web's `primitives.tsx` component-for-component:
 * this app's own established visual language (StyleSheet, no CSS-shorthand
 * className merging) and its own simpler patterns (a bare text empty hint,
 * not web's icon-in-a-disc `Empty`) are what these match — the same
 * "primitives that fit this platform's own conventions, not a translation
 * of another platform's" instinct `avatar.tsx`'s own header states for why
 * it draws initials rather than porting web's `AvatarStack`.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BUTTON_BG: Readonly<Partial<Record<ButtonVariant, string>>> = {
  primary: colors.accent.hex,
  secondary: colors.surfaceRaised.hex,
};

const BUTTON_TEXT_COLOR: Readonly<Record<ButtonVariant, string>> = {
  primary: colors.accentInk.hex,
  secondary: colors.ink.hex,
  ghost: colors.accent.hex,
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  textStyle,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly style?: ViewStyle;
  /** An override for the label's own size/weight — a smaller inline
   * secondary button (e.g. "Resend verification email" inside a notice
   * box) needs a smaller label than this component's own default 16px,
   * and there is no honest way to express that through `style` alone,
   * since `style` targets the `Pressable`, not the `Text` inside it. */
  readonly textStyle?: TextStyle;
}) {
  const textColor = BUTTON_TEXT_COLOR[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={[
        variant === 'ghost' ? styles.ghostButton : styles.button,
        variant !== 'ghost' && { backgroundColor: BUTTON_BG[variant] },
        variant === 'secondary' && styles.secondaryButtonBorder,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <Text style={[styles.buttonText, { color: textColor }, textStyle]}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * Label + `TextInput` + optional error/hint line — `(auth)/sign-in.tsx`'s
 * own label-above-input-below-hint shape, generalized. `error` and `hint`
 * are mutually exclusive by convention (an error already tells the person
 * what's wrong; showing a hint underneath it at the same time is noise),
 * so only `error` renders when both are given.
 */
export function TextField({
  label,
  error,
  hint,
  style,
  ...inputProps
}: {
  readonly label: string;
  readonly error?: string;
  readonly hint?: string;
  readonly style?: ViewStyle;
} & TextInputProps) {
  return (
    <View style={style}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.inkFaint.hex} {...inputProps} />
      {error !== undefined && error !== '' ? (
        <Text style={styles.fieldError} accessibilityRole="alert">
          {error}
        </Text>
      ) : hint !== undefined && hint !== '' ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export type BadgeTone = 'default' | 'accent' | 'danger' | 'success' | 'warning';

const BADGE_BG: Readonly<Record<BadgeTone, string>> = {
  default: colors.surfaceHover.hex,
  accent: colors.accent.hex,
  danger: colors.danger.hex,
  success: colors.success.hex,
  warning: colors.warning.hex,
};

/* Only `default` needs its own text color — every other tone's own paired
   ink token already exists (accentInk/dangerInk); `success`/`warning` have
   none yet, so they reuse `surface.hex` (a dark neutral), verified the same
   way the toast/notification-bell contrast fixes elsewhere in this pass
   were: both backgrounds are light enough (success L=70%, warning L=76%)
   that a dark ink is the correct pairing, not an approximation. */
const BADGE_TEXT: Readonly<Record<BadgeTone, string>> = {
  default: colors.inkMuted.hex,
  accent: colors.accentInk.hex,
  danger: colors.dangerInk.hex,
  success: colors.surface.hex,
  warning: colors.surface.hex,
};

export function Badge({
  label,
  tone = 'default',
}: {
  readonly label: string;
  readonly tone?: BadgeTone;
}) {
  return (
    <View style={[styles.badge, { backgroundColor: BADGE_BG[tone] }]}>
      <Text style={[styles.badgeText, { color: BADGE_TEXT[tone] }]}>{label}</Text>
    </View>
  );
}

/**
 * The plain centered hint line every screen's own `emptyHint` style already
 * renders identically (`fontSize: 13, color: colors.inkFaint.hex`) — kept
 * to exactly that, not upgraded to web's icon-in-a-disc `Empty`, since
 * nothing about this app's own established screens ever asked for one.
 * `style` carries each screen's own spacing (several genuinely differ —
 * `marginTop`, `paddingHorizontal`, `paddingVertical` — real per-screen
 * layout, not drift worth removing).
 */
export function EmptyHint({
  children,
  style,
}: {
  readonly children: ReactNode;
  readonly style?: ViewStyle;
}) {
  return <Text style={[styles.emptyHint, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radiusCard + 2,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonBorder: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  ghostButton: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.inkMuted.hex,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  fieldError: {
    marginTop: 4,
    fontSize: 13,
    color: colors.danger.hex,
  },
  fieldHint: {
    marginTop: 4,
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
});
