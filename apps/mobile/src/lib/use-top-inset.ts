import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * A screen's top padding, safe-area-aware — found needed on a real device,
 * not designed ahead of one: every screen's outer container hardcoded
 * `paddingTop: 24`, which happened to look fine on the one device this was
 * checked against but is not actually correct in general (a taller status
 * bar/notch eats into the same fixed 24px everywhere else gets clean).
 * `SafeAreaProvider` already wraps the whole app (`app/_layout.tsx`) — this
 * is the missing other half, reading its actual insets instead of guessing
 * a constant.
 *
 * For a screen whose scrollable content includes its own header (the
 * back button, a title) as the FIRST item — `card/[cardId].tsx`,
 * `board/[boardId].tsx`, `project/[projectId].tsx`, `channel/
 * [channelId].tsx` — this is one half of a two-part fix, not the whole
 * one: `app.config.ts`'s `androidStatusBar` (`translucent: false`) is the
 * other, load-bearing half. Padding alone only sets where content STARTS;
 * unbounded scrolling still carries it past that point eventually,
 * regardless of how much padding there is. An opaque status bar is what
 * actually stops content from ever being VISIBLE there once scrolled —
 * this padding is what keeps it from starting there in the first place,
 * which is what makes the very first, unscrolled render also look right.
 */
export function useTopInset(extra = 24): number {
  return useSafeAreaInsets().top + extra;
}
