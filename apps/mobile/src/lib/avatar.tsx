import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@taskflow/tokens';

/**
 * An initials circle — the "no avatars" gap `README.md`'s Wave 2 section
 * names ("Web's `AvatarStack` needs a members lookup and image loading
 * neither of which exist on mobile yet") is only half true now that
 * `use-members.ts` provides the lookup. The other half — no image loading —
 * is still real, so this draws initials on a deterministic color rather than
 * fetching a photo, the same trade Slack/Linear's own fallback avatars make
 * when there is no uploaded picture.
 */

const PALETTE = [
  colors.accent.hex,
  colors.priorityUrgent.hex,
  colors.success.hex,
  colors.warning.hex,
  colors.priorityMedium.hex,
] as const;

/** Deterministic so the same person gets the same color on every render, every screen. */
function colorFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? colors.accent.hex;
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({
  label,
  size = 32,
}: {
  readonly label: string;
  readonly size?: number;
}): ReactNode {
  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(label) },
      ]}
    >
      <Text style={[styles.text, { fontSize: size * 0.4 }]}>{initialsOf(label)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: colors.accentInk.hex,
    fontWeight: '700',
  },
});
