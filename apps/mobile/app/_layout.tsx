import { useCallback, useEffect, useState } from 'react';
import { router, Slot } from 'expo-router';
import {
  AppState,
  type AppStateStatus,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { errorCodeOf, isUnauthenticated } from '../src/lib/trpc-client.js';
import { biometricGate, session } from '../src/lib/app-session.js';
import { useSession } from '../src/lib/use-session.js';
import { attachNotificationResponseListener } from '../src/lib/push-notifications.js';
import { BrandingProvider } from '../src/lib/branding-provider.js';
import { useBranding } from '../src/lib/branding-context.js';

/**
 * The root layout — the outermost thing on screen, ever (ai/phase-14-mobile.md
 * §7). One `QueryClient` for the app's lifetime, and the auth gate's first
 * half: `session.restore()` runs exactly once, at boot, and nothing below this
 * component renders until its `status` has settled out of `'restoring'`.
 *
 * That "nothing renders" is load-bearing, not cosmetic. `(app)/_layout.tsx`
 * and `(auth)/_layout.tsx` both read `session`'s status to decide where to
 * redirect; mounting them while a stored refresh token is still being
 * exchanged would have them redirect to sign-in, then immediately redirect
 * again once `restore()` resolves — a visible flash, and a real screen making
 * a real decision on stale information. A splash is the honest state for
 * "we do not know yet."
 *
 * ## The biometric app-lock gate (§4.4) sits ABOVE all of that
 *
 * `unlockState` decides whether `session.restore()` is even allowed to run
 * yet — the gate is "does a found-and-unlocked phone get to attempt reading
 * the stored refresh token at all", not a check inside the token exchange
 * itself. That is why it lives here and not in `session.ts`: gating the
 * exchange would mean prompting Face ID on every ordinary mid-session
 * access-token renewal, not just once per cold start.
 *
 * `checking` runs `session.hasStoredCredential()` — nothing to protect for a
 * caller who has never signed in, so a first launch skips straight to
 * `unlocked` with no prompt. `locked` auto-attempts the platform ceremony
 * once; failing or cancelling it leaves the app on the lock screen with a
 * retry button, never falling through to `restore()` — the stored token
 * stays right where it was, untouched, exactly as the spec says: "a local
 * gate... it never replaces `can()` or the token."
 *
 * `createQueryClient` is `@taskflow/client`'s shared retry policy and
 * defaults (ai/phase-14-mobile.md §12 decision 4) — the same one apps/web
 * builds on, minus an `onCacheError`: apps/web's NOT_A_MEMBER recovery is a
 * REACTIVE response to a failed query; `org-gate.ts`'s `resolveRememberedOrg`
 * already validates the remembered org BEFORE anything org-scoped renders,
 * so there is no Wave 1 screen this app needs the reactive path for yet.
 *
 * Also mounts the tapped-notification listener (Phase 14 §9,
 * `push-notifications.ts`'s own header) — unconditionally, like `AppState`
 * below, since listening for a tap costs nothing and prompts no permission.
 */
const queryClient = createQueryClient({ isUnauthenticated, errorCodeOf });

/**
 * Wires `refetchOnWindowFocus`/`refetchOnReconnect` (`@taskflow/client`'s
 * shared defaults, set for both platforms) to something that actually
 * fires on React Native. TanStack Query's `focusManager` listens for the
 * DOM's `visibilitychange` by default, which does not exist here — found
 * by checking, not assumed, while documenting the boards/comments/chat
 * batch below: every screen in this app was refetching on navigation and
 * NEVER on foregrounding the app, silently, because this call was missing.
 * Exactly the shape TanStack Query's own React Native guide describes:
 * `AppState`'s `'active'` maps to focused, anything else (`'background'`,
 * `'inactive'`) does not. Mobile-only wiring, so it lives here rather than
 * in `@taskflow/client`'s `createQueryClient` — apps/web's browser already
 * has a working `visibilitychange` listener and needs none of this.
 */
function onAppStateChange(status: AppStateStatus): void {
  focusManager.setFocused(status === 'active');
}

type UnlockState = 'checking' | 'locked' | 'unlocked';

export default function RootLayout() {
  const [unlockState, setUnlockState] = useState<UnlockState>('checking');

  useEffect(() => {
    void (async () => {
      const hasCredential = await session.hasStoredCredential();
      const gateAvailable = hasCredential && (await biometricGate.isAvailable());
      if (!gateAvailable) {
        setUnlockState('unlocked');
        void session.restore();
        return;
      }
      setUnlockState('locked');
    })();
  }, []);

  // Runs for the app's whole lifetime, not tied to `unlockState` — a query
  // firing while locked is already refused elsewhere (there is no session
  // to attach it to), so this only ever needs to exist once.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => {
      subscription.remove();
    };
  }, []);

  // The tapped-notification listener (push-notifications.ts's own header) —
  // same unconditional, whole-lifetime placement as the `AppState` listener
  // above, and for the identical reason: listening costs nothing and
  // prompts no permission, unlike ACTUALLY registering for push (which only
  // ever runs from a button on the account screen).
  useEffect(() => {
    return attachNotificationResponseListener((path) => {
      router.push(path);
    });
  }, []);

  const attemptUnlock = useCallback(() => {
    void (async () => {
      if (await biometricGate.authenticate()) {
        setUnlockState('unlocked');
        void session.restore();
      }
    })();
  }, []);

  // Prompt once, automatically, the moment the app decides a gate is
  // needed — the common case is opening the app and Face ID just working,
  // not landing on an extra screen first to press a button.
  useEffect(() => {
    if (unlockState === 'locked') attemptUnlock();
  }, [unlockState, attemptUnlock]);

  const status = useSession((state) => state.status);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <BrandingProvider>
          {unlockState === 'checking' && <Splash />}
          {unlockState === 'locked' && <LockScreen onRetry={attemptUnlock} />}
          {unlockState === 'unlocked' && (status === 'restoring' ? <Splash /> : <Slot />)}
        </BrandingProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Splash() {
  return (
    <View style={styles.splash}>
      <ActivityIndicator color={colors.accent.hex} />
    </View>
  );
}

function LockScreen({ onRetry }: { onRetry: () => void }) {
  const { productName } = useBranding();
  return (
    <View style={styles.splash}>
      <Text style={styles.lockTitle}>{productName} is locked</Text>
      <Text style={styles.lockSubtitle}>Unlock with Face ID, fingerprint, or your passcode.</Text>
      <Pressable style={styles.button} onPress={onRetry}>
        <Text style={styles.buttonText}>Unlock</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
    padding: 24,
    gap: 12,
  },
  lockTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  lockSubtitle: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    marginBottom: 8,
  },
  button: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  buttonText: {
    color: colors.accentInk.hex,
    fontSize: 16,
    fontWeight: '600',
  },
});
