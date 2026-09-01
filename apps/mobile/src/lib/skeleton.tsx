import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type DimensionValue, type ViewStyle } from 'react-native';
import { colors } from '@taskflow/tokens';

interface SkeletonProps {
  readonly width: DimensionValue;
  readonly height: number;
  readonly style?: ViewStyle;
  readonly borderRadius?: number;
}

/** Single shimmer bar. Pulses opacity 0.4 → 1 → 0.4 on a 1.2s loop. */
export function Skeleton({ width, height, style, borderRadius = 6 }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 600, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [opacity]);

  // Wrap in a plain View for dimensions; only the inner Animated.View carries opacity
  // so the width type stays DimensionValue (not constrained by Animated.View's style).
  return (
    <View style={[{ width, height, borderRadius, overflow: 'hidden' }, style]}>
      <Animated.View style={{ flex: 1, backgroundColor: colors.line.hex, opacity }} />
    </View>
  );
}

/** Row skeleton: one wider bar and one narrow bar, mimicking a channel/card row. */
export function SkeletonRow({ style }: { readonly style?: ViewStyle }) {
  return (
    <View style={[skeletonStyles.row, style]}>
      <View style={skeletonStyles.rowLeft}>
        <Skeleton width={36} height={36} borderRadius={18} />
      </View>
      <View style={skeletonStyles.rowRight}>
        <Skeleton width="80%" height={13} />
        <Skeleton width="50%" height={11} style={skeletonStyles.subLine} />
      </View>
    </View>
  );
}

/** Stack of N skeleton rows for use as a list placeholder. */
export function SkeletonList({ count = 5 }: { readonly count?: number }) {
  return (
    <View>
      {Array.from({ length: count }, (_, i) =>
        i > 0 ? <SkeletonRow key={i} style={skeletonStyles.listGap} /> : <SkeletonRow key={i} />,
      )}
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowLeft: {},
  rowRight: {
    flex: 1,
    gap: 6,
  },
  subLine: {
    marginTop: 2,
  },
  listGap: {
    marginTop: 16,
  },
});
