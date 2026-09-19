/**
 * Shared premium UI utilities — shadow system, press feedback, animated
 * expand/collapse, loading skeletons, card surface helpers, and empty state
 * component.
 *
 * This module is the single source of truth for every elevated surface on
 * mobile. The web design system (styles.css) uses layered CSS shadows;
 * React Native needs platform-specific handling: iOS gets `shadowColor` /
 * `shadowOffset` / `shadowOpacity` / `shadowRadius`; Android gets `elevation`.
 * Keeping both in one place prevents the drift where one platform has depth
 * and the other is flat.
 *
 * ## Shadow depth levels
 *
 * - `shadowSm` (elevation 2): subtle lift for cards, list items, badges
 * - `shadowMd` (elevation 4): moderate lift for expanded panels, popovers
 * - `shadowLg` (elevation 8): prominent lift for modals, floating elements
 *
 * All shadows use the warm-dark palette's overlay color (#120904) at low
 * opacity, matching styles.css's own `--shadow-sm: 0 1px 2px oklch(.../0.2)`.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { colors, motion, radiusCard } from '@taskflow/tokens';
import { Skeleton } from './skeleton.js';

/* -------------------------------------------------------------------------- *
 * Shadow tokens
 * -------------------------------------------------------------------------- */

export const SHADOW_COLOR = '#120904';

/**
 * Standard opacity for press feedback across the app. Applied via
 * `pressed && styles.pressed` on Pressable components. Using a constant
 * ensures all press interactions feel consistent.
 */
export const PRESS_FEEDBACK = 0.7;

/** Shared hit-slop for small pressable targets (back arrows, icons, chips). */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

/** Platform-appropriate monospace font. Menlo renders more consistently on iOS. */
export const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export const shadows = {
  sm: Platform.select({
    ios: {
      shadowColor: SHADOW_COLOR,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 2,
    },
    android: {
      elevation: 2,
    },
    default: {},
  }) as ViewStyle,

  md: Platform.select({
    ios: {
      shadowColor: SHADOW_COLOR,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
    },
    android: {
      elevation: 4,
    },
    default: {},
  }) as ViewStyle,

  lg: Platform.select({
    ios: {
      shadowColor: SHADOW_COLOR,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
    },
    android: {
      elevation: 8,
    },
    default: {},
  }) as ViewStyle,
} as const;

/* -------------------------------------------------------------------------- *
 * Card surface — consistent elevated card with border + shadow
 * -------------------------------------------------------------------------- */

export const cardSurface: ViewStyle = {
  borderRadius: radiusCard,
  borderWidth: 1,
  borderColor: colors.line.hex,
  backgroundColor: colors.surfaceRaised.hex,
  ...shadows.sm,
};

/* -------------------------------------------------------------------------- *
 * PressableCard — pressable with shadow + haptics + opacity feedback
 * -------------------------------------------------------------------------- */

/**
 * A `Pressable` that lifts slightly on press with haptic feedback, used for
 * every tappable card surface (rule cards, member rows, team cards, etc.).
 *
 * `onPress` is deliberately required — a card with no tap target should be
 * a plain `View` with `cardSurface` style, not an inert-looking pressable.
 */
export function PressableCard({
  children,
  onPress,
  style,
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly onPress: () => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly disabled?: boolean;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[cardSurface, animStyle]}>
      <Pressable
        disabled={disabled}
        onPressIn={() => {
          if (!disabled)
            scale.value = withTiming(0.98, {
              duration: motion.fast,
              easing: Easing.out(Easing.cubic),
            });
        }}
        onPressOut={() => {
          scale.value = withTiming(1, {
            duration: motion.base,
            easing: Easing.out(Easing.cubic),
          });
        }}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        }}
        style={[StyleSheet.absoluteFill, style]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

/* -------------------------------------------------------------------------- *
 * Animated expand/collapse — for automations run history, etc.
 * -------------------------------------------------------------------------- */

/**
 * An expandable container that animates height from 0 to measured content.
 * `expanded` toggles between collapsed (height 0, hidden) and expanded
 * (content at natural height).
 */
export function AnimatedExpand({
  expanded,
  children,
}: {
  readonly expanded: boolean;
  readonly children: ReactNode;
}) {
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);

  const animStyle = useAnimatedStyle(() => ({
    height: height.value,
    opacity: opacity.value,
    overflow: 'hidden' as const,
  }));

  useEffect(() => {
    height.value = withTiming(expanded ? height.value : 0, {
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
    });
    opacity.value = withTiming(expanded ? 1 : 0, {
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
    });
  }, [expanded, height, opacity]);

  return (
    <Animated.View style={animStyle}>
      <View
        onLayout={(e) => {
          if (expanded) {
            height.value = withTiming(e.nativeEvent.layout.height, {
              duration: motion.base,
              easing: Easing.out(Easing.cubic),
            });
          }
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
}

/* -------------------------------------------------------------------------- *
 * Header loading skeletons
 * -------------------------------------------------------------------------- */

/**
 * A compact header skeleton for screens that show title + subtitle while
 * loading. Prevents layout shift by occupying the same space the real
 * content will fill.
 */
export function HeaderSkeleton() {
  return (
    <View style={headerSkeletonStyles.container}>
      <Skeleton width={140} height={24} borderRadius={6} />
      <Skeleton width={200} height={13} borderRadius={4} />
    </View>
  );
}

const headerSkeletonStyles = StyleSheet.create({
  container: {
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
});

/**
 * A stat card skeleton for insights / billing while loading.
 */
export function StatBoxSkeleton() {
  return (
    <View style={statBoxSkeletonStyles.container}>
      <Skeleton width={50} height={22} borderRadius={4} />
      <Skeleton width={70} height={11} borderRadius={3} />
    </View>
  );
}

const statBoxSkeletonStyles = StyleSheet.create({
  container: {
    flexBasis: '47%',
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line.hex,
    gap: 6,
  },
});

/**
 * A card skeleton for billing/invoices/features while loading.
 */
export function CardSkeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <View style={cardSkeletonStyles.card}>
      <Skeleton width={100} height={12} borderRadius={3} />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} width={'80%'} height={12} borderRadius={3} />
      ))}
    </View>
  );
}

/**
 * Premium empty state — a centered icon, title, description, and optional
 * action button. Used for "no projects yet", "no cards here", "no results",
 * etc. Matches web's empty state pattern but with a richer visual.
 *
 * `icon` accepts a ReactNode (typically an `<Ionicons>` element), NOT a
 * raw emoji string. This ensures consistent iconography across the app.
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View style={emptyStateStyles.container}>
      {icon ? <View style={emptyStateStyles.iconContainer}>{icon}</View> : null}
      <Text style={emptyStateStyles.title}>{title}</Text>
      {description ? <Text style={emptyStateStyles.description}>{description}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          style={({ pressed }) => [emptyStateStyles.action, pressed && { opacity: 0.7 }]}
        >
          <Text style={emptyStateStyles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const emptyStateStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  iconContainer: {
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    textAlign: 'center',
    marginBottom: 4,
  },
  description: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    lineHeight: 18,
  },
  action: {
    marginTop: 16,
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard + 2,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accentInk.hex,
  },
});

const cardSkeletonStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    borderWidth: 1,
    borderColor: colors.line.hex,
    padding: 16,
    gap: 8,
  },
});

/**
 * Premium error state — a centered error icon, title, message, and retry
 * button. Matches the EmptyState visual language. Used for "could not load",
 * "something went wrong", etc.
 */
export function ErrorView({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  readonly title?: string;
  readonly message?: string | undefined;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) {
  return (
    <View style={errorViewStyles.container}>
      <Ionicons name="warning" size={32} color={colors.danger.hex} style={errorViewStyles.icon} />
      <Text style={errorViewStyles.title}>{title}</Text>
      {message ? <Text style={errorViewStyles.message}>{message}</Text> : null}
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => [errorViewStyles.retry, pressed && { opacity: 0.7 }]}
        >
          <Text style={errorViewStyles.retryText}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const errorViewStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  icon: {
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    textAlign: 'center',
    marginBottom: 4,
  },
  message: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 4,
  },
  retry: {
    marginTop: 12,
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: radiusCard + 2,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
});
