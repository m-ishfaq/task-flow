/**
 * Where tapping a delivered notification navigates — mobile's OWN
 * translation of `apps/api/src/platform/notification-paths.ts`'s WEB-shaped
 * path, which is what actually arrives in a notification's `data.path`
 * (the push relay computes one path and both channels — web push and
 * `ExpoPushProvider` — carry it verbatim; see `notification-push.ts`'s own
 * `ExpoPushSendInput.path`). Web's route shape (`/chat?channel=X`,
 * `/boards/X?card=Y`) has no relationship to this app's segment-based
 * routes (`/channel/[channelId]`, `/card/[cardId]`), so a raw
 * `router.push(webPath)` would 404 on every tap.
 *
 * A separate file from `push-notifications.ts` (which calls this)
 * specifically so it stays testable with no Expo/React Native runtime —
 * `push-notifications.ts` itself imports `react-native` and
 * `expo-constants`, both of which fail to even PARSE under Vitest (Flow
 * syntax in `react-native`'s own source), the same "split for testability"
 * call `config.ts`'s own header already makes for `app-session.ts`'s
 * `Constants` read.
 *
 * Returns `null` for a shape this app has no screen for yet (`/docs?...` —
 * no Docs feature on native at all — and `/settings`, a membership-change
 * link with no mobile equivalent), the same "no honest way to guess, so
 * don't" call `rich-text.ts`'s sanitizer makes for a node it cannot repair.
 * A `null` means the notification still opened the app; it just does not
 * additionally navigate anywhere.
 */
export function mobilePathFor(webPath: string): string | null {
  const chatMatch = /^\/chat\?channel=([^&]+)$/.exec(webPath);
  if (chatMatch?.[1] !== undefined) return `/channel/${chatMatch[1]}`;

  const cardMatch = /^\/boards\/[^/?]+\?card=([^&]+)$/.exec(webPath);
  if (cardMatch?.[1] !== undefined) return `/card/${cardMatch[1]}`;

  return null;
}
