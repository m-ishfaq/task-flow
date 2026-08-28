import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useBranding, usePaletteColors } from './branding-context.js';

/**
 * The product's mark on native — ported from `apps/web/src/components/
 * brand-mark.tsx`, scoped down for the platform.
 *
 * Web falls back to an inline SVG (three connected nodes, `currentColor`)
 * when no custom logo is uploaded. That is deliberately NOT ported here:
 * `react-native-svg` is already a transitive dependency (via
 * `react-native-qrcode-svg`, see `qr-code.tsx`), but every native-module
 * import in this codebase goes through a memoized dynamic `import()` —
 * `qr-code.tsx`'s own header explains why (a native module's entry file
 * commonly calls `requireNativeModule` at ITS top level, which throws
 * wherever the module is not yet linked: Expo Go always, any build made
 * before the dependency existed). Introducing a second, STATIC entry point
 * into that same native module for a purely decorative fallback is a risk
 * this component does not need to take. A colored initial badge — the exact
 * pattern `avatar.tsx` already uses for the identical "no image, need
 * something on-brand" problem — costs nothing and crashes nothing.
 */
export function BrandMark({ size = 40 }: { readonly size?: number }): ReactNode {
  const { logoUrl, productName } = useBranding();
  const palette = usePaletteColors();

  if (logoUrl !== null) {
    return (
      <Image
        source={{ uri: logoUrl }}
        accessibilityLabel={productName}
        style={[styles.image, { width: size, height: size, borderRadius: size * 0.25 }]}
        resizeMode="contain"
      />
    );
  }

  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: palette.base },
      ]}
      accessibilityLabel={productName}
    >
      <Text style={[styles.text, { fontSize: size * 0.42, color: palette.ink }]}>
        {productName.charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: 'transparent',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: '700',
  },
});
