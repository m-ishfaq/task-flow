import { useMemo } from 'react';
import { Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { CHANNELS_QUERY_KEY, unreadCountsQueryKey } from '../../../src/lib/chat.js';
import { ORG_DETAIL_QUERY_KEY } from '../../../src/lib/org-settings.js';

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
 * hand-built approximation. Five tabs today, in the same order CLAUDE.md's
 * own top line names the product's modules ("Work, Chat, Docs, Voice &
 * Messaging, People, Platform") — "My Tasks" and "Boards" both being Work,
 * then "Chat", then "Docs" (`docs.tsx` — spaces and the page tree; see
 * `docs.ts`'s own header for what does and does not ship yet), then "Calls"
 * (Voice & Messaging — Phase 7's telephony client, real, separate from
 * Phase 13's in-app WebRTC calling, which has no tab of its own and instead
 * rings from whatever screen is open, `call-surface.tsx`). People and
 * Platform are the two modules with no tab: People because nobody browses
 * the org directory BETWEEN other work the way they browse boards or chat
 * (see below), and Platform because this app has no operator console at
 * all.
 *
 * **People traded places with Docs, rather than Docs taking a sixth
 * slot.** `Tabs` has no scroll behaviour when it overflows a phone's
 * width, so this bar was already full at five before Docs existed —
 * something had to give up its slot. People was the one tab where "browse
 * it between other work" was the weaker fit of the five: you go to the
 * directory to LOOK SOMEONE UP, not to scroll it the way a board or an
 * inbox gets scrolled, which is the same "who reaches for this mid-task"
 * test that kept Account off this bar in the first place. `people.tsx`
 * itself is unchanged in shape, just moved from `(tabs)/people.tsx` to a
 * pushed sibling of `automations.tsx` under `(app)/`, reached from
 * `account.tsx`'s new "People" link — the identical move Automations and
 * Account made before it, for the identical reason.
 *
 * **Account is NOT a tab any more either — it moved to a top-right icon,
 * `top-bar.tsx`, next to the notification bell.** Account was the one
 * existing tab nothing routes to mid-task the way a card or a channel
 * does — nobody swipes to it between other work — so it is the screen
 * that loses nothing by becoming a single tap from a fixed icon instead
 * of a tab. `top-bar.tsx`'s own header has the full argument.
 *
 * **`@expo/vector-icons` (`Ionicons`), not "no icon set" as originally
 * shipped.** That original call was "nothing else in this app uses one
 * yet" — true, and beside the point once a real device run showed what
 * omitting `tabBarIcon` actually renders: not blank space, but a visibly
 * broken glyph box on every tab, on every screen, permanently on-screen
 * chrome rather than a one-off cosmetic gap. `Ionicons` ships bundled with
 * every Expo SDK template specifically for this — `checkmark-circle` (My
 * Tasks), `grid` (Boards), `chatbubbles` (Chat), `document-text` (Docs),
 * `call` (Calls), each with a matching `-outline` variant for the inactive
 * state, which is what `focused` below switches between.
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
  const org = useQuery({
    queryKey: ORG_DETAIL_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
  });
  /* Phase 15 §1 — the five telephony permissions are no longer Member role
     defaults, they are individually granted (`authz.member_grants`), so a
     Member can hold any SUBSET of them rather than all-or-nothing. `href:
     null` below (not omitting the `<Tabs.Screen>` entirely) hides the tab
     from the bar while `calls.tsx` still handles someone reaching it some
     other way — the same reasoning `apps/web/src/components/sidebar.tsx`'s
     `anyOfCapabilities` states for the `/calls` nav item. Defaults to
     hidden while loading, the fail-closed direction — a tab flashing in
     then disappearing is a worse "wait, do I have this or not" moment than
     one appearing a beat late. */
  const capabilities = org.data?.capabilities;
  const showCalls =
    capabilities !== undefined &&
    (capabilities.readPhoneNumbers ||
      capabilities.placeCalls ||
      capabilities.readCalls ||
      capabilities.sendSms ||
      capabilities.readSms);

  const channels = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.channels.list.query()),
  });
  const channelIds = useMemo(
    () => channels.data?.channels.map((c) => c.channelId) ?? [],
    [channels.data],
  );
  const unread = useQuery({
    queryKey: unreadCountsQueryKey(channelIds),
    queryFn: async () => wire(await apiClient.chat.channels.unreadCounts.query({ channelIds })),
    enabled: channelIds.length > 0,
    refetchInterval: 15_000,
  });
  const totalUnread = useMemo(
    () => (unread.data ?? []).reduce((sum, row) => sum + row.unreadCount, 0),
    [unread.data],
  );

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
          fontSize: 12,
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
          /* The suite spectrum, parity with web's product rail: each product's
             active tab takes its own hue (`@taskflow/tokens` chat/docs/calls),
             so the bar reads as a suite rather than one accent repeated five
             times. Home and Boards (both Work) keep the global accent — Work is
             the accent hue on web too. The inactive tint stays neutral. */
          tabBarActiveTintColor: colors.chat.hex,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'chatbubbles' : 'chatbubbles-outline'}
              color={color}
              size={size}
            />
          ),
          ...(totalUnread > 0 ? { tabBarBadge: totalUnread > 99 ? '99+' : totalUnread } : {}),
        }}
      />
      <Tabs.Screen
        name="docs"
        options={{
          title: 'Docs',
          tabBarActiveTintColor: colors.docs.hex,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? 'document-text' : 'document-text-outline'}
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
          tabBarActiveTintColor: colors.calls.hex,
          // `exactOptionalPropertyTypes` refuses an explicit `undefined` for
          // `href` (it wants the key omitted, not set to undefined) — so the
          // "show" case spreads no override at all rather than `href: undefined`.
          ...(showCalls ? {} : { href: null }),
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'call' : 'call-outline'} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
