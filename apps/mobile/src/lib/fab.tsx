import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@taskflow/tokens';

/**
 * The floating action button for a screen's own primary action.
 *
 * ## Why this exists (and why it is NOT in the title row)
 *
 * The app-wide chrome — Account, Search, the notification bell (`top-bar.tsx`)
 * — is a single absolute overlay pinned to the TOP-RIGHT of every screen. A
 * screen that also puts its create action (`+ New space`, `+ New project`) in
 * its own top-right title row lands it directly under that cluster: content
 * starts at `useTopInset` (`insets.top + 24`) while the chrome band runs to
 * `insets.top + 40`, so the two overlap by ~16px on the right edge, on every
 * screen at once. The title escapes only because it is left-aligned; the
 * action does not.
 *
 * Moving the action to a bottom-right FAB gives the top-right entirely to the
 * app-wide chrome and the bottom-right to the screen — the two never compete
 * for the same corner again. A standard mobile "create" affordance, and the
 * one placement that cannot re-collide however the header grows.
 *
 * ## Bottom offset
 *
 * The screen container is `flex: 1`, so `bottom` is measured from the content
 * area's own lower edge. On a TAB screen that edge already sits above the tab
 * bar, so the caller passes a small `bottom` (the tab bar owns the safe-area
 * inset). On a PUSHED screen there is no tab bar, so the default adds
 * `insets.bottom` to clear the home indicator. Passing `bottom` explicitly is
 * always allowed; the default is the pushed-screen value.
 */

const BASE_BOTTOM = 24;
const RIGHT = 20;
const SIZE = 56;

type IconName = keyof typeof Ionicons.glyphMap;

export function Fab(props: {
  readonly onPress: () => void;
  readonly label: string;
  readonly icon?: IconName;
  readonly bottom?: number;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const bottom = props.bottom ?? insets.bottom + BASE_BOTTOM;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [styles.fab, { bottom }, pressed && styles.pressed]}
    >
      <Ionicons name={props.icon ?? 'add'} size={26} color={colors.accentInk.hex} />
    </Pressable>
  );
}

export interface FabAction {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly onPress: () => void;
}

/**
 * A FAB that opens a small action menu — for the two screens that carry more
 * than one screen-scoped action (Chat: New + Saved; a Docs space: New page +
 * Templates). Folding them into one menu keeps BOTH out of the top-right,
 * which a second title-row button would not.
 */
export function FabMenu(props: {
  readonly actions: readonly FabAction[];
  readonly label?: string;
  readonly bottom?: number;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const bottom = props.bottom ?? insets.bottom + BASE_BOTTOM;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label ?? 'Actions'}
        onPress={() => {
          setOpen(true);
        }}
        style={({ pressed }) => [styles.fab, { bottom }, pressed && styles.pressed]}
      >
        <Ionicons name="add" size={26} color={colors.accentInk.hex} />
      </Pressable>

      <Modal
        transparent
        visible={open}
        animationType="fade"
        onRequestClose={() => {
          setOpen(false);
        }}
      >
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Dismiss menu"
          onPress={() => {
            setOpen(false);
          }}
        >
          <View style={[styles.menu, { right: RIGHT, bottom: bottom + SIZE + 12 }]}>
            {props.actions.map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => {
                  setOpen(false);
                  action.onPress();
                }}
                style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
              >
                <Ionicons name={action.icon} size={18} color={colors.ink.hex} />
                <Text style={styles.menuLabel}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: RIGHT,
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.hex,
    /* Sits above the list but below the app-wide chrome overlay
       (`top-bar.tsx` uses zIndex/elevation 20). */
    zIndex: 15,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  pressed: {
    backgroundColor: colors.accentHover.hex,
  },
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
  },
  menu: {
    position: 'absolute',
    minWidth: 188,
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line.hex,
    paddingVertical: 6,
    zIndex: 25,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  menuRowPressed: {
    backgroundColor: colors.line.hex + '55',
  },
  menuLabel: {
    color: colors.ink.hex,
    fontSize: 15,
    fontWeight: '600',
  },
});
