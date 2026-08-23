import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type * as Y from 'yjs';
import { colors } from '@taskflow/tokens';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useDocPage, type DocPageStatus } from '../../../src/lib/use-doc-page.js';
import { yjsFragmentToRichTextDocument } from '../../../src/lib/docs-collab.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';

/**
 * A page's live content, read-only — reached by tapping a page row on
 * `docs-space/[spaceId].tsx` (its own header explains why that screen never
 * had this destination before). The counterpart of `apps/web/src/features/
 * docs/editor/docs-editor.tsx`'s `DocsEditor`, minus the half that cannot
 * exist here: `useDocPage`'s own header names the reason there is no
 * `useEditor` call anywhere on this screen — ProseMirror needs a DOM, and
 * React Native has none. What the two screens share is everything that
 * does not: the same `HocuspocusProvider`/`Y.Doc` connection, the same
 * `content` Yjs fragment, and — via `yjsFragmentToRichTextDocument` — the
 * same rendering this app already ships for Work (`rich-text-view.tsx`).
 *
 * Nothing here re-derives authorization (CLAUDE.md §8.2), the same as web's
 * editor: `apps/collab/src/authorize.ts` is what actually decides whether
 * this connection may read the page at all, and a refusal there surfaces as
 * the connection never reaching `synced`, not as a client-side check.
 */
export default function DocsPageScreen() {
  const params = useLocalSearchParams<{ pageId: string }>();
  const pageId = params.pageId;
  const orgId = useSession((state) => state.orgId);
  const paddingTop = useTopInset();

  const { doc, status, synced } = useDocPage(orgId, pageId);

  /* Sticky, not the raw `synced` flag directly — a later reconnect can flip
     `synced` back to `false` while the already-loaded `Y.Doc` still holds
     every update it received, and re-hiding real content behind a spinner
     on every network blip would be a worse experience than the pill alone
     going stale for a moment. This only gates the FIRST render of content:
     "have we ever had a complete picture," not "are we connected right
     now." */
  const [hasEverSynced, setHasEverSynced] = useState(synced);
  useEffect(() => {
    if (synced) setHasEverSynced(true);
  }, [synced]);

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Pressable
        style={styles.backButton}
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      {/* A second row, below the back button — never beside it. `top-bar.tsx`
          mounts Account + the notification bell as a fixed overlay above
          EVERY screen in `(app)/`, at `top: insets.top + 4`; every other
          screen's header (`automations.tsx`, `org-settings.tsx`,
          `docs-space/[spaceId].tsx`) already keeps its own right-aligned
          content on a row below the back button for exactly this reason —
          this screen originally put the pill BESIDE the back button, in
          that same band, and the fixed overlay drew over it and hid it
          completely. Found live: the pill was there, cycling status, just
          never visible. */}
      <View style={styles.titleRow}>
        <Text style={styles.title}>Page</Text>
        <ConnectionPill status={status} synced={synced} />
      </View>

      {!hasEverSynced ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent.hex} />
          <Text style={styles.loadingHint}>
            {status === 'disconnected' ? 'Reconnecting…' : 'Connecting…'}
          </Text>
        </View>
      ) : doc === null ? null : (
        <PageContent doc={doc} />
      )}
    </View>
  );
}

/**
 * Re-renders on every Yjs update to the page's content, not just on mount —
 * a page open while someone else is editing must show what they typed, not
 * a snapshot from the moment this screen connected. `observeDeep` is the
 * one Yjs subscription that fires for a change anywhere in the subtree
 * (a mark added three levels down is still a "deep" change on the root
 * fragment), which is what a text-level edit inside a paragraph actually
 * is. `sanitizeRichText` runs again inside `RichTextView` on every one of
 * these — `docs-collab.ts`'s own header is why that safety net, not this
 * function, is what a subtly-wrong walk falls back to.
 */
function PageContent({ doc }: { readonly doc: Y.Doc }) {
  const fragment = doc.getXmlFragment('content');
  const [document, setDocument] = useState<{ readonly content: readonly unknown[] }>(
    () => yjsFragmentToRichTextDocument(fragment) as { readonly content: readonly unknown[] },
  );

  useEffect(() => {
    const update = () => {
      setDocument(
        yjsFragmentToRichTextDocument(fragment) as { readonly content: readonly unknown[] },
      );
    };
    update();
    fragment.observeDeep(update);
    return () => {
      fragment.unobserveDeep(update);
    };
  }, [fragment]);

  /* `RichTextView` renders nothing at all for an empty document (correct
     for Work, where an empty description is unremarkable) — on a screen
     whose only content IS this, that reads identically to the loading
     state this component only mounts after, so a genuinely empty page
     gets its own explicit, distinguishable message instead of a second
     blank screen. */
  if (document.content.length === 0) {
    return <Text style={styles.emptyHint}>This page has no content yet.</Text>;
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <RichTextView document={document} />
    </ScrollView>
  );
}

/** The native counterpart of `docs-editor.tsx`'s own `ConnectionPill`. */
function ConnectionPill({
  status,
  synced,
}: {
  readonly status: DocPageStatus;
  readonly synced: boolean;
}) {
  const label =
    status === 'connected'
      ? synced
        ? 'Live'
        : 'Syncing…'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Offline';
  const dotColor =
    status === 'connected'
      ? synced
        ? colors.success.hex
        : colors.warning.hex
      : status === 'connecting'
        ? colors.warning.hex
        : colors.danger.hex;

  return (
    <View style={styles.pill}>
      <View style={[styles.pillDot, { backgroundColor: dotColor }]} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillText: {
    fontSize: 11,
    color: colors.inkMuted.hex,
  },
  loading: {
    marginTop: 40,
    alignItems: 'center',
    gap: 8,
  },
  loadingHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  emptyHint: {
    marginTop: 24,
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  scrollContent: {
    paddingBottom: 40,
  },
});
