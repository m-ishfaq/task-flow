import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Ionicons } from '@expo/vector-icons';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import {
  SEARCH_FACETS,
  SEARCH_TYPE_COLOR,
  SEARCH_TYPE_LABEL,
  hitTitle,
  searchQueryKey,
  withFacet,
  type SearchFacet,
  type SearchHit,
} from './search.js';

/**
 * Cross-product search (Phase 8), as a modal reached from `top-bar.tsx`'s
 * icon row — mobile's counterpart to `apps/web/src/features/search`'s own
 * `/search` route. A bottom sheet rather than a full screen: unlike Docs or
 * Work, a search result is always a JUMP to somewhere else, never a place
 * to linger, so `notification-bell.tsx`'s trigger-plus-sheet shape (not a
 * pushed route) is the closer fit, and this file mirrors its structure
 * deliberately — same 36×36 trigger sized into `top-bar.tsx`'s row, same
 * backdrop/handle/card sheet.
 *
 * ## What this does NOT port, and why
 *
 * Saved searches (`search.saved.*`) are not wired up here. Web's list is a
 * CRUD surface with its own share-with-org toggle and a `broken` flag that
 * needs its own row treatment (§ the research this file was built from) —
 * real UI, not a few extra lines, and a sheet meant to be opened, typed
 * in, and dismissed in a few seconds is the wrong place for a management
 * screen. A named gap, not a silent one: worth a dedicated screen later,
 * the same way Docs' page editor got its own pass once reading was solid.
 * `search.saved.*` are not called from anywhere in this file.
 *
 * The live per-token TQL error underline is also skipped — `@taskflow/filter`
 * is not a dependency of this app, and does not need to become one: a bare
 * typed word is already valid, complete TQL (`parse.ts`'s `freeText()`
 * desugars it to `text contains "..."`), so this box can forward whatever
 * the user types straight through. A user who types real TQL syntax and
 * gets it wrong sees the server's own `VALIDATION` error, the same as any
 * other tRPC failure this app already renders — there is no local parser
 * copy to keep in sync with the real one.
 */
export function SearchButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        style={styles.trigger}
        accessibilityLabel="Search"
        onPress={() => {
          setOpen(true);
        }}
      >
        <Ionicons
          name={open ? 'search' : 'search-outline'}
          size={18}
          color={open ? colors.accent.hex : colors.ink.hex}
        />
      </Pressable>

      <SearchModal
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

function SearchModal({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [facet, setFacet] = useState<SearchFacet>('all');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(text);
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);

  const effectiveQuery = withFacet(debounced, facet);
  const sendable = effectiveQuery.trim() !== '';

  const results = useQuery({
    queryKey: searchQueryKey(effectiveQuery),
    queryFn: () => apiClient.search.query.query({ query: effectiveQuery, limit: 50 }),
    enabled: open && sendable,
  });

  const openHit = (hit: SearchHit): void => {
    onClose();
    const meta = hit.metadata;
    switch (hit.type) {
      case 'card': {
        router.push(`/card/${hit.entityId}`);
        return;
      }
      case 'message': {
        if ('channel_id' in meta) router.push(`/channel/${meta.channel_id}`);
        return;
      }
      case 'page': {
        if ('space_id' in meta) {
          router.push({
            pathname: '/docs-page/[pageId]',
            params: { pageId: hit.entityId, spaceId: meta.space_id },
          });
        }
        return;
      }
      case 'comment': {
        if ('card_id' in meta) {
          router.push(`/card/${meta.card_id}`);
        } else if ('page_id' in meta) {
          router.push({
            pathname: '/docs-page/[pageId]',
            params: { pageId: meta.page_id, spaceId: meta.space_id },
          });
        }
        return;
      }
      case 'transcript': {
        /* No per-call route exists on mobile yet (unlike web's `?call=`
           auto-expand) — the Calls tab is the honest destination; opening
           the specific recording is future work, not a broken link. */
        router.push('/calls');
        return;
      }
    }
  };

  const hits = results.data ?? [];

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.modalBackdrop} onPress={onClose}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <View style={styles.modalHandle} />
            <View style={styles.searchInputRow}>
              <Ionicons name="search" size={16} color={colors.inkFaint.hex} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search cards, messages, pages…"
                placeholderTextColor={colors.inkFaint.hex}
                value={text}
                onChangeText={setText}
                autoFocus
                returnKeyType="search"
              />
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.facetRow}>
              {SEARCH_FACETS.map((option) => (
                <Pressable
                  key={option.id}
                  style={[styles.facetChip, facet === option.id && styles.facetChipActive]}
                  onPress={() => {
                    setFacet(option.id);
                  }}
                >
                  <Text
                    style={[
                      styles.facetChipText,
                      facet === option.id && styles.facetChipTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <ScrollView style={styles.resultsScroll}>
              {!sendable ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyIcon}>🔎</Text>
                  <Text style={styles.emptyHint}>
                    Type to search across cards, messages, pages, comments and call transcripts.
                  </Text>
                </View>
              ) : results.isPending ? (
                <ActivityIndicator style={styles.loading} color={colors.accent.hex} />
              ) : results.isError ? (
                <Text style={styles.errorText}>
                  {apiErrorOf(results.error)?.error.message ?? 'Search failed.'}
                </Text>
              ) : hits.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyIcon}>🔎</Text>
                  <Text style={styles.emptyTitle}>No results</Text>
                  <Text style={styles.emptyHint}>Nothing matched that query.</Text>
                </View>
              ) : (
                hits.map((hit) => (
                  <SearchHitRow
                    key={`${hit.type}:${hit.entityId}`}
                    hit={hit}
                    onOpen={() => {
                      openHit(hit);
                    }}
                  />
                ))
              )}
            </ScrollView>

            <Pressable style={styles.modalCancel} onPress={onClose}>
              <Text style={styles.modalCancelText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SearchHitRow({ hit, onOpen }: { readonly hit: SearchHit; readonly onOpen: () => void }) {
  return (
    <Pressable style={styles.hitRow} onPress={onOpen}>
      <View style={styles.hitTop}>
        <View style={[styles.hitBadge, { backgroundColor: `${SEARCH_TYPE_COLOR[hit.type]}22` }]}>
          <Text style={[styles.hitBadgeText, { color: SEARCH_TYPE_COLOR[hit.type] }]}>
            {SEARCH_TYPE_LABEL[hit.type]}
          </Text>
        </View>
        {hit.archived && (
          <View style={styles.archivedPill}>
            <Text style={styles.archivedPillText}>Archived</Text>
          </View>
        )}
        <Text style={styles.hitTime} numberOfLines={1}>
          {formatDistanceToNow(new Date(hit.updatedAt), { addSuffix: true })}
        </Text>
      </View>
      <Text style={styles.hitTitle} numberOfLines={1}>
        {hitTitle(hit)}
      </Text>
      {hit.snippet !== null && (
        <Text style={styles.hitSnippet} numberOfLines={2}>
          {hit.snippet}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /* Must stay pixel-identical to `top-bar.tsx`'s own `iconButton` /
     `notification-bell.tsx`'s `trigger` style — a third differently-sized
     button in the same row would look like a mistake. */
  trigger: {
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised.hex,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  avoider: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    paddingHorizontal: 20,
    paddingBottom: 20,
    paddingTop: 10,
    height: '80%',
  },
  modalHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    marginBottom: 14,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radiusCard,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    backgroundColor: colors.surfaceSunken.hex,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.ink.hex,
  },
  facetRow: {
    flexDirection: 'row',
    maxHeight: 40,
    marginBottom: 10,
  },
  facetChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  facetChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  facetChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  facetChipTextActive: {
    color: colors.accentInk.hex,
  },
  resultsScroll: {
    flex: 1,
  },
  loading: {
    marginTop: 24,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    textAlign: 'center',
    marginTop: 24,
  },
  empty: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 32,
  },
  emptyIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    textAlign: 'center',
    maxWidth: 260,
  },
  hitRow: {
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radiusCard,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  hitTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hitBadge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  hitBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  archivedPill: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: colors.surfaceSunken.hex,
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  archivedPillText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.inkFaint.hex,
  },
  hitTime: {
    marginLeft: 'auto',
    fontSize: 10,
    color: colors.inkFaint.hex,
  },
  hitTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  hitSnippet: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
});
