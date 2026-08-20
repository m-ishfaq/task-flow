import { useEffect } from 'react';
import { Slot } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { errorCodeOf, isUnauthenticated } from '../src/lib/trpc-client.js';
import { session } from '../src/lib/app-session.js';
import { useSession } from '../src/lib/use-session.js';

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
 * `createQueryClient` is `@taskflow/client`'s shared retry policy and
 * defaults (ai/phase-14-mobile.md §12 decision 4) — the same one apps/web
 * builds on, minus an `onCacheError`: apps/web's NOT_A_MEMBER recovery is a
 * REACTIVE response to a failed query; `org-gate.ts`'s `resolveRememberedOrg`
 * already validates the remembered org BEFORE anything org-scoped renders,
 * so there is no Wave 1 screen this app needs the reactive path for yet.
 */
const queryClient = createQueryClient({ isUnauthenticated, errorCodeOf });

export default function RootLayout() {
  useEffect(() => {
    void session.restore();
  }, []);

  const status = useSession((state) => state.status);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {status === 'restoring' ? <Splash /> : <Slot />}
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

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
});
