import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import {
  SPACES_QUERY_KEY,
  buildPageTree,
  descendantIdsOf,
  pagesQueryKey,
  type Page,
  type PageTreeRow,
} from '../../../src/lib/docs.js';

/**
 * One space's page tree — reached by tapping a space on the Docs tab.
 * `docs.ts`'s own header has the full account of what this screen does
 * and does not do: create, rename, move, and archive/restore pages, all
 * pure tree structure, no content. There is no "open a page" destination
 * from here on purpose — there is nothing on this platform yet that could
 * render what a tap would open.
 *
 * `buildPageTree` flattens the whole tree into one indented list with no
 * collapse/expand state — every page is always visible, which is the
 * simpler choice for a first pass and matches `board/[boardId].tsx`'s own
 * "no drag-and-drop" call: real, separate work if a space ever grows large
 * enough that collapsing sections becomes worth the added state.
 *
 * "Move" only ever appends a page to the END of its new parent's children
 * (`beforePageId`/`afterPageId` both null) — the identical "append only,
 * no reordering within a level" choice `board/[boardId].tsx`'s own card
 * "Move" button already makes, for the same reason: a client-computed
 * position is stale the moment two people move things around at once, and
 * this app has no drag gesture to make a precise mid-list drop meaningful
 * anyway. `descendantIdsOf` keeps the move target picker from ever
 * offering a page's own descendant, which would create a cycle the server
 * would refuse anyway — filtering it out client-side is a better
 * experience than offering it and then explaining why not.
 */
export default function DocsSpaceScreen() {
  const params = useLocalSearchParams<{ spaceId: string }>();
  const spaceId = params.spaceId;
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();

  const spaces = useQuery({
    queryKey: SPACES_QUERY_KEY,
    queryFn: async () => wire(await apiClient.docs.spaces.list.query()),
  });
  const space = spaces.data?.find((entry) => entry.spaceId === spaceId);

  const pages = useQuery({
    queryKey: pagesQueryKey(spaceId),
    queryFn: async () => wire(await apiClient.docs.pages.list.query({ spaceId })),
  });
  const rows = buildPageTree(pages.data ?? []);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: pagesQueryKey(spaceId) });
  };

  const [creatingUnder, setCreatingUnder] = useState<string | null>();
  const [newTitle, setNewTitle] = useState('');
  const [optionsFor, setOptionsFor] = useState<Page | null>(null);
  const [optionsTitle, setOptionsTitle] = useState('');
  const [movingPage, setMovingPage] = useState<Page | null>(null);

  const createPage = useMutation({
    mutationFn: (input: { parentPageId: string | null; title: string }) =>
      apiClient.docs.pages.create.mutate({ spaceId, ...input }),
    onSuccess: () => {
      invalidate();
      setCreatingUnder(undefined);
      setNewTitle('');
    },
    onError: (error: unknown) => {
      Alert.alert('This page could not be created', apiErrorOf(error)?.error.message);
    },
  });

  const renamePage = useMutation({
    mutationFn: (input: { pageId: string; title: string }) =>
      apiClient.docs.pages.update.mutate(input),
    onSuccess: () => {
      invalidate();
      setOptionsFor(null);
    },
    onError: (error: unknown) => {
      Alert.alert('This page could not be renamed', apiErrorOf(error)?.error.message);
    },
  });

  const movePage = useMutation({
    mutationFn: (input: { pageId: string; targetParentId: string | null }) =>
      apiClient.docs.pages.move.mutate({
        pageId: input.pageId,
        targetParentId: input.targetParentId,
        beforePageId: null,
        afterPageId: null,
      }),
    onSuccess: () => {
      invalidate();
      setMovingPage(null);
      setOptionsFor(null);
    },
    onError: (error: unknown) => {
      Alert.alert('This page could not be moved', apiErrorOf(error)?.error.message);
    },
  });

  const archivePage = useMutation({
    mutationFn: (input: { pageId: string; restore: boolean }) =>
      apiClient.docs.pages.archive.mutate(input),
    onSuccess: () => {
      invalidate();
      setOptionsFor(null);
    },
    onError: (error: unknown) => {
      Alert.alert('That could not be updated', apiErrorOf(error)?.error.message);
    },
  });

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
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {space?.name ?? 'Space'}
        </Text>
        <Pressable
          style={styles.newButton}
          onPress={() => {
            setCreatingUnder(null);
          }}
        >
          <Text style={styles.newButtonText}>+ New page</Text>
        </Pressable>
      </View>

      {pages.isPending && <ActivityIndicator style={styles.loading} color={colors.accent.hex} />}
      {pages.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(pages.error)?.error.message ?? 'Could not load this space.'}
        </Text>
      )}
      {pages.isSuccess && rows.length === 0 && (
        <Text style={styles.emptyHint}>No pages yet. Tap "+ New page" above to add one.</Text>
      )}

      <FlatList<PageTreeRow>
        data={rows}
        keyExtractor={(row) => row.page.pageId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[
              styles.row,
              { paddingLeft: 12 + item.depth * 18 },
              item.page.archivedAt !== null && styles.rowArchived,
            ]}
            onPress={() => {
              setOptionsFor(item.page);
              setOptionsTitle(item.page.title);
            }}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.page.title}
            </Text>
            {item.page.publishedAt !== null && (
              <View style={styles.publishedBadge}>
                <Text style={styles.publishedBadgeText}>Published</Text>
              </View>
            )}
            <Text style={styles.rowChevron}>⋯</Text>
          </Pressable>
        )}
      />

      <CreatePageModal
        visible={creatingUnder !== undefined}
        parentTitle={
          creatingUnder === null || creatingUnder === undefined
            ? null
            : (pages.data?.find((page) => page.pageId === creatingUnder)?.title ?? null)
        }
        title={newTitle}
        onChangeTitle={setNewTitle}
        pending={createPage.isPending}
        error={createPage.error}
        onCreate={() => {
          createPage.mutate({ parentPageId: creatingUnder ?? null, title: newTitle.trim() });
        }}
        onClose={() => {
          setCreatingUnder(undefined);
          setNewTitle('');
        }}
      />

      <PageOptionsModal
        page={optionsFor}
        title={optionsTitle}
        onChangeTitle={setOptionsTitle}
        renamePending={renamePage.isPending}
        archivePending={archivePage.isPending}
        onSaveTitle={() => {
          if (optionsFor === null) return;
          renamePage.mutate({ pageId: optionsFor.pageId, title: optionsTitle.trim() });
        }}
        onAddChild={() => {
          if (optionsFor === null) return;
          setCreatingUnder(optionsFor.pageId);
          setOptionsFor(null);
        }}
        onMove={() => {
          setMovingPage(optionsFor);
        }}
        onArchive={() => {
          if (optionsFor === null) return;
          archivePage.mutate({
            pageId: optionsFor.pageId,
            restore: optionsFor.archivedAt !== null,
          });
        }}
        onClose={() => {
          setOptionsFor(null);
        }}
      />

      <MoveTargetModal
        page={movingPage}
        rows={rows}
        pending={movePage.isPending}
        onSelect={(targetParentId) => {
          if (movingPage === null) return;
          movePage.mutate({ pageId: movingPage.pageId, targetParentId });
        }}
        onClose={() => {
          setMovingPage(null);
        }}
      />
    </View>
  );
}

function CreatePageModal({
  visible,
  parentTitle,
  title,
  onChangeTitle,
  pending,
  error,
  onCreate,
  onClose,
}: {
  readonly visible: boolean;
  readonly parentTitle: string | null;
  readonly title: string;
  readonly onChangeTitle: (value: string) => void;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.modalBackdrop} onPress={onClose}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>New page</Text>
            {parentTitle !== null && <Text style={styles.modalHint}>Under "{parentTitle}"</Text>}
            <TextInput
              style={styles.modalInput}
              placeholder="Page title"
              placeholderTextColor={colors.inkFaint.hex}
              value={title}
              onChangeText={onChangeTitle}
              maxLength={200}
              autoFocus
            />
            {error !== null && (
              <Text style={styles.errorText} accessibilityRole="alert">
                {apiErrorOf(error)?.error.message ?? 'The page was not created.'}
              </Text>
            )}
            <View style={styles.modalActions}>
              <Pressable
                style={[
                  styles.modalPrimaryButton,
                  (pending || title.trim() === '') && styles.buttonDisabled,
                ]}
                disabled={pending || title.trim() === ''}
                onPress={onCreate}
              >
                <Text style={styles.modalPrimaryButtonText}>Create</Text>
              </Pressable>
              <Pressable style={styles.modalSecondaryButton} onPress={onClose}>
                <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PageOptionsModal({
  page,
  title,
  onChangeTitle,
  renamePending,
  archivePending,
  onSaveTitle,
  onAddChild,
  onMove,
  onArchive,
  onClose,
}: {
  readonly page: Page | null;
  readonly title: string;
  readonly onChangeTitle: (value: string) => void;
  readonly renamePending: boolean;
  readonly archivePending: boolean;
  readonly onSaveTitle: () => void;
  readonly onAddChild: () => void;
  readonly onMove: () => void;
  readonly onArchive: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible={page !== null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.modalBackdrop} onPress={onClose}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Page options</Text>
            <TextInput
              style={styles.modalInput}
              value={title}
              onChangeText={onChangeTitle}
              maxLength={200}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={[
                  styles.modalPrimaryButton,
                  (renamePending || title.trim() === '' || title.trim() === page?.title) &&
                    styles.buttonDisabled,
                ]}
                disabled={renamePending || title.trim() === '' || title.trim() === page?.title}
                onPress={onSaveTitle}
              >
                <Text style={styles.modalPrimaryButtonText}>Save name</Text>
              </Pressable>
              <Pressable style={styles.modalSecondaryButton} onPress={onClose}>
                <Text style={styles.modalSecondaryButtonText}>Close</Text>
              </Pressable>
            </View>

            <Pressable style={styles.modalOptionRow} onPress={onAddChild}>
              <Text style={styles.modalOptionText}>New page here</Text>
            </Pressable>
            <Pressable style={styles.modalOptionRow} onPress={onMove}>
              <Text style={styles.modalOptionText}>Move to…</Text>
            </Pressable>
            <Pressable style={styles.modalOptionRow} disabled={archivePending} onPress={onArchive}>
              <Text style={styles.modalDangerText}>
                {page?.archivedAt !== null && page?.archivedAt !== undefined
                  ? 'Restore this page'
                  : 'Archive this page'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function MoveTargetModal({
  page,
  rows,
  pending,
  onSelect,
  onClose,
}: {
  readonly page: Page | null;
  readonly rows: readonly PageTreeRow[];
  readonly pending: boolean;
  readonly onSelect: (targetParentId: string | null) => void;
  readonly onClose: () => void;
}) {
  const blocked =
    page === null
      ? new Set<string>()
      : descendantIdsOf(
          rows.map((row) => row.page),
          page.pageId,
        );
  const options = rows.filter((row) => !blocked.has(row.page.pageId));

  return (
    <Modal visible={page !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Move "{page?.title}" to…</Text>
          <ScrollView style={styles.modalList} nestedScrollEnabled>
            <Pressable
              style={styles.modalOptionRow}
              disabled={pending}
              onPress={() => {
                onSelect(null);
              }}
            >
              <Text style={styles.modalOptionText}>Top level</Text>
            </Pressable>
            {options.map((row) => (
              <Pressable
                key={row.page.pageId}
                style={[styles.modalOptionRow, { paddingLeft: 12 + row.depth * 18 }]}
                disabled={pending}
                onPress={() => {
                  onSelect(row.page.pageId);
                }}
              >
                <Text style={styles.modalOptionText} numberOfLines={1}>
                  {row.page.title}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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
    gap: 10,
    marginBottom: 10,
  },
  title: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  newButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newButtonText: {
    color: colors.accentInk.hex,
    fontSize: 12,
    fontWeight: '700',
  },
  loading: {
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  list: {
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingRight: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowArchived: {
    opacity: 0.6,
  },
  rowTitle: {
    flex: 1,
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowChevron: {
    fontSize: 14,
    color: colors.inkFaint.hex,
  },
  publishedBadge: {
    backgroundColor: colors.success.hex + '1A',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  publishedBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.success.hex,
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
    padding: 20,
    gap: 10,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  modalHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    marginTop: -6,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  modalSecondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  modalSecondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalOptionRow: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
  },
  modalOptionText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  modalDangerText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  modalList: {
    maxHeight: 320,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
