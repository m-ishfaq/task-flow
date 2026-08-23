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

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.headerRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </Pressable>
        <ConnectionPill status={status} synced={synced} />
      </View>

      {doc === null ? (
        <ActivityIndicator style={styles.loading} color={colors.accent.hex} />
      ) : (
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
  const [document, setDocument] = useState<unknown>(() => yjsFragmentToRichTextDocument(fragment));

  useEffect(() => {
    const update = () => {
      setDocument(yjsFragmentToRichTextDocument(fragment));
    };
    update();
    fragment.observeDeep(update);
    return () => {
      fragment.unobserveDeep(update);
    };
  }, [fragment]);

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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
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
  },
  scrollContent: {
    paddingBottom: 40,
  },
});
