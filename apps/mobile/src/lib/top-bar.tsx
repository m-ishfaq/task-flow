import { Pressable, StyleSheet, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@taskflow/tokens';
import { NotificationBell } from './notification-bell.js';

/**
 * The top-right chrome cluster — Account, then the notification bell,
 * mounted once in `(app)/_layout.tsx` above every screen, the same
 * "one overlay, not four copies" pattern `call-surface.tsx` and
 * `notification-bell.tsx` already established for their own reasons.
 *
 * ## Why Account moved out of the tab bar
 *
 * `(tabs)/_layout.tsx` carried six tabs, and a live report asked for two
 * more real destinations (Docs, Automations) that have no screen yet —
 * `Tabs` has no scroll behaviour when it overflows a phone's width, so
 * "just add two more `Tabs.Screen`s" was never going to fit. Account was
 * the one existing tab that is not a place you browse — nothing paginates
 * through it, nothing else routes there mid-task the way a card or a
 * channel does — so it is the one screen that loses nothing by becoming a
 * single tap from a fixed icon instead of a swipeable destination.
 * `account.tsx` itself did not change shape: it moved from
 * `(tabs)/account.tsx` to `(app)/account.tsx`, a sibling of
 * `org-settings.tsx`, gaining only the back button every other pushed
 * screen already draws (that header's own comment on `<Stack>`
 * auto-registration is why the move needed no routing change beyond the
 * file's own path).
 *
 * ## One row, not two independently-positioned overlays
 *
 * `notification-bell.tsx` used to own its own `position: 'absolute'`
 * placement (`right: 16, top: insets.top + 4`) as the only thing anchored
 * up there. Adding a second icon by giving IT an independent `right`
 * offset would mean two components each guessing the other's width to
 * avoid overlapping — exactly the kind of drift that goes unnoticed until
 * a longer unread-count badge (`9+`) collides with its neighbour. This
 * component owns the ONE absolute position; `NotificationBell` now renders
 * a plain, unpositioned trigger sized to sit inside this row, so the two
 * icons are pixel-aligned by construction (same `top`, a fixed `gap`)
 * rather than by two numbers happening to agree.
 */
export function TopBar(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const onAccountScreen = pathname === '/account';

  return (
    <View style={[styles.row, { top: insets.top + 4 }]} pointerEvents="box-none">
      <Pressable
        style={styles.iconButton}
        accessibilityLabel="Account"
        onPress={() => {
          if (!onAccountScreen) router.push('/account');
        }}
      >
        <Ionicons
          name={onAccountScreen ? 'person-circle' : 'person-circle-outline'}
          size={20}
          color={onAccountScreen ? colors.accent.hex : colors.ink.hex}
        />
      </Pressable>
      <NotificationBell />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 20,
    elevation: 20,
  },
  /* Must stay pixel-identical to `notification-bell.tsx`'s own `trigger`
     style (36×36, same radius/background/border) — two visibly
     different-sized buttons in the same row would look like a mistake
     rather than a deliberate pairing. */
  iconButton: {
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised.hex,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
});
