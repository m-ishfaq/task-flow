import { type ReactNode } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './card-detail-styles.js';

/**
 * A titled card wrapping one field/section of the detail screen — added for
 * the "too much info, we can't tell which one to focus on, can't
 * distinguish what is what" feedback on a real device (2026-08-22). Every
 * section previously shared one plain text label (the old `sprintSection`/
 * `sprintSectionLabel` pair, now renamed `section`/`sectionLabel` since
 * this component is what uses them) with no visual boundary between it and
 * its neighbour, so "Status", "Priority" and "Sprint" read as one
 * undifferentiated column of chips. This reuses `card-row.tsx`'s own `card`
 * tile look (border + `surfaceRaised` background) — already the app's
 * established "this is one distinct thing" idiom for a card tile on "My
 * Tasks" and the board — rather than inventing a second grouped-block
 * visual language for this one screen.
 */
export function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * A chip row that scrolls horizontally instead of wrapping onto a second
 * and third line — the direct answer to "if there are many labels, status
 * etc why not put them in one row and if more we can use x axis scroll."
 * Mirrors `board/[boardId].tsx`'s own tab strip exactly, including both
 * halves of its fix for a horizontal `ScrollView` inside a flex column:
 * `chipScrollFrame`'s `flexGrow`/`flexShrink: 0` stops the FRAME from
 * stretching to fill the remaining column space (which renders every chip
 * as a near-fullscreen vertical pill), and `chipScroll`'s
 * `alignItems: 'flex-start'` stops each CHIP inside it from stretching to
 * match the frame — see that file's own `tabStripFrame` comment; both are
 * needed, not just one.
 */
export function ChipScroll({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScrollFrame}
      contentContainerStyle={styles.chipScroll}
    >
      {children}
    </ScrollView>
  );
}

export function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}
