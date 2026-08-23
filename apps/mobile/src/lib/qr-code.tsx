import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { colors } from '@taskflow/tokens';
import type * as QrCodeModule from 'react-native-qrcode-svg';

/**
 * A QR code, for `totp-section.tsx`'s enrollment screen — the one screen in
 * this app that needs to render one.
 *
 * `react-native-qrcode-svg` (and its `react-native-svg` peer, real native
 * code on both platforms) is loaded with a memoized dynamic `import()`,
 * never a static top-level one — the same shape `device-key.ts`'s
 * `getNative()`, `biometric-gate.native.ts`'s dynamic `expo-local-
 * authentication` import, and `passkeys.ts`'s `loadPasskeys()` all use, for
 * the identical reason each of their own headers documents: a native
 * module's own entry file commonly calls `requireNativeModule`/
 * `requireNativeComponent` at ITS top level, which throws the moment
 * anything imports it wherever the module is not yet linked (Expo Go
 * always; any development build made before this dependency existed) — and
 * a static import inside a file reachable from the main tab bar
 * (`account.tsx` → `totp-section.tsx` → here) poisons Metro's whole module
 * graph before a single screen renders, exactly the failure this app's own
 * README documents twice already for the two previous native modules it
 * added. Failing to load renders nothing (`null`) rather than throwing —
 * `TotpSection` falls back to the manual secret, which is still a complete,
 * usable enrollment path on its own.
 */
let modulePromise: Promise<typeof QrCodeModule> | undefined;

async function loadQrCode(): Promise<typeof QrCodeModule> {
  modulePromise ??= import('react-native-qrcode-svg');
  return modulePromise;
}

export function QrCode({ value, size = 160 }: { readonly value: string; readonly size?: number }) {
  const [Rendered, setRendered] = useState<(typeof QrCodeModule)['default'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadQrCode()
      .then((mod) => {
        if (!cancelled) setRendered(() => mod.default);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;

  if (Rendered === null) {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.ink.hex} />
      </View>
    );
  }

  return <Rendered value={value} size={size} backgroundColor="white" color="black" />;
}
