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
 * hand-built approximation. Four tabs today — "My Tasks", "Boards" (Wave
 * 2's remaining item — projects/boards/lists, `boards.tsx`), "Chat" (Wave
 * 3, read + send only — see `chat.ts`'s own header) and "Account" (org
 * switching, passkeys, sign-out) — because those are the destinations that
 * exist; Docs/People join this bar as their own waves ship real screens,
 * the same way `apps/web`'s `Sidebar` grew its nav rail one item per phase
 * rather than all at once.
 *
 * Text-only tab labels, no icon set: nothing else in this app uses one yet
 * (`home.tsx`, `sign-in.tsx` are all plain `Pressable`/`Text`), and adding
 * an icon library is its own dependency decision this increment does not
 * need to make.
 *
 * `card/[cardId].tsx` stays a SIBLING of this `(tabs)` group, not nested
 * inside it — `(app)/_layout.tsx` renders a bare `<Slot />` with no
 * navigator of its own, so pushing to `/card/:id` replaces this whole tab
 * view rather than opening within it, which is the correct native pattern
 * for a detail screen (a phone does not want a tab bar competing with a
 * card's own "← Back" for screen space).
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
          borderTopColor: colors.line.hex,
        },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'My Tasks' }} />
      <Tabs.Screen name="boards" options={{ title: 'Boards' }} />
      <Tabs.Screen name="chat" options={{ title: 'Chat' }} />
      <Tabs.Screen name="account" options={{ title: 'Account' }} />
    </Tabs>
  );
}
