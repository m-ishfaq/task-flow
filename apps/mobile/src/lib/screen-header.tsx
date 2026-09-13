import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { colors } from '@taskflow/tokens';

/**
 * A pushed screen's own title block — Design Bible §15's own finding:
 * "Titles run under the top-bar icons." `top-bar.tsx` mounts one persistent
 * Account/Search/Notifications cluster, absolutely positioned at the top
 * right of EVERY screen (`zIndex: 20`); a screen's own title row that also
 * put something right-aligned there (a "Billing" link, a "+ Add" button)
 * would sit under, or crowd against, that fixed cluster — which is exactly
 * what happened on the Members and Individual permissions screens the
 * Design Bible names by name.
 *
 * The fix is structural, not a one-off repositioning: this component has no
 * trailing-action slot at all, on purpose. A screen with its own action
 * (invite, add, transfer) renders it as its own row BELOW this header,
 * never beside the title — so the collision this component exists to fix
 * cannot recur the next time a screen grows a button, the same "impossible
 * to express, not merely discouraged" instinct CLAUDE.md's own guardrails
 * apply to security; here to layout.
 */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
}): ReactNode {
  return (
    <View style={styles.container}>
      <Pressable
        style={styles.backButton}
        hitSlop={8}
        onPress={() => {
          if (onBack) onBack();
          else router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>{title}</Text>
      {subtitle !== undefined && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

/**
 * The fixed cluster's own footprint from the right edge — `top-bar.tsx`'s
 * `right: 16` plus three 36px icons and two 8px gaps (36×3 + 8×2 = 124).
 * Exported for the rare screen that genuinely needs a right-aligned element
 * at the SAME height as the icon row (nothing does today — `ScreenHeader`
 * above is how every screen avoids needing one at all) rather than left to
 * be rediscovered by trial and error against a real device.
 */
export const TOPBAR_ICON_CLEARANCE = 16 + 36 * 3 + 8 * 2;

const styles = StyleSheet.create({
  container: {
    marginBottom: 8,
    gap: 2,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
});
