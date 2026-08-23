import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { colors } from '@taskflow/tokens';

/**
 * The tab bar — the navigation-shell increment a real device run found
 * missing entirely (`ai/phase-14-mobile.md` names no shell for Wave 2
 * beyond "one placeholder home screen" in Wave 1; nothing since then ever
 * built the surrounding frame apps/web has had since Phase 3).
 *
 * A BOTTOM TAB BAR, not a sidebar drawer — `apps/web`'s `Sidebar` is a
 * desktop-shaped pattern (a persistent rail beside the content); the native
 * equivalent for a phone-width screen is the platform's own primary-nav
 * idiom (iOS's tab bar, Android's bottom navigation), which `expo-router`'s
 * `Tabs` renders as the native component on each platform rather than a
 * hand-built approximation. Six tabs today — "My Tasks", "Boards" (Wave
 * 2's remaining item — projects/boards/lists, `boards.tsx`), "Chat" (Wave
 * 3, read + send only — see `chat.ts`'s own header), "Calls" (Phase 7's
 * telephony client, `calls.tsx` — real, separate from Phase 13's in-app
 * WebRTC calling, which has no tab of its own and instead rings from
 * whatever screen is open, `call-surface.tsx`), "People" (Phase 11.5's org
 * directory, `people.tsx` — the caller's OWN profile lives on the Account
 * tab instead, `people.profile.*`; this tab is `people.directory.*`, a
 * different member and a different set of screens) and "Account" (org
 * switching, passkeys, sign-out) — because those are the destinations that
 * exist; Docs joins this bar as its own wave ships a real screen, the same
 * way `apps/web`'s `Sidebar` grew its nav rail one item per phase rather
 * than all at once.
 *
 * **`@expo/vector-icons` (`Ionicons`), not "no icon set" as originally
 * shipped.** That original call was "nothing else in this app uses one
 * yet" — true, and beside the point once a real device run showed what
 * omitting `tabBarIcon` actually renders: not blank space, but a visibly
 * broken glyph box on every tab, on every screen, permanently on-screen
 * chrome rather than a one-off cosmetic gap. `Ionicons` ships bundled with
 * every Expo SDK template specifically for this — `checkmark-circle` (My
 * Tasks), `grid` (Boards), `chatbubbles` (Chat), `call` (Calls), `people`
 * (People), `person-circle` (Account), each with a matching `-outline`
 * variant for the inactive state, which is what `focused` below switches
 * between.
 *
 * `card/[cardId].tsx` stays a SIBLING of this `(tabs)` group, not nested
 * inside it — `(app)/_layout.tsx` now composes both into one real
 * `<Stack>` (see that layout's own header for why it has to, after a real
 * device run found `router.back()` landing on My Tasks from every screen
 * with no stack there at all), so pushing to `/card/:id` still replaces
 * this whole tab view in the UI rather than opening within it — the
 * correct native pattern for a detail screen — while now ALSO leaving a
 * real history entry for `back()` to return to.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent.hex,
        tabBarInactiveTintColor: colors.inkMuted.hex,
        tabBarStyle: {
          backgroundColor: colors.surfaceRaised.hex,
          borderTopWidth: 0,
          ...Platform.select({
            ios: {
              shadowColor: '#000',
              shadowOffset: { width: 0, height: -2 },
              shadowOpacity: 0.15,
              shadowRadius: 8,
            },
            android: {
              elevation: 8,
            },
          }),
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'My Tasks',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'checkmark-circle' : 'checkmark-circle-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="boards"
        options={{
          title: 'Boards',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'grid' : 'grid-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'chatbubbles' : 'chatbubbles-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: 'Calls',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'call' : 'call-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'people' : 'people-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'person-circle' : 'person-circle-outline'}
              color={color}
              size={size}
            />
          ),
        }}
      />
    </Tabs>
  );
}
