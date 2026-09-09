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
import { templatesQueryKey, type DocTemplate } from '../../../src/lib/docs-templates.js';

const TEMPLATE_HINTS: Record<string, string> = {
  'Meeting notes': 'Agenda, action items, and decisions in one place.',
  'Onboarding checklist': 'Step-by-step tasks for new team members.',
  'Project brief': 'Goals, scope, and key stakeholders at a glance.',
  'Weekly update': 'Summarize progress, blockers, and next steps.',
  'Decision record': 'Context, options considered, and the outcome.',
};

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
 * A row tap now opens `docs-page/[pageId].tsx` — the live reader
 * `use-doc-page.ts` exists for — rather than `PageOptionsModal` directly;
 * a long press is what opens options now, the same `onPress`/`onLongPress`
 * split `board/[boardId].tsx`'s own list-tab row already uses for the
 * identical "one primary destination, one secondary action sheet" shape.
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
 *
 * Page templates (Phase 6 Wave 4) are fully portable to this screen with
 * no editor at all — `docs.templates.createPage` copies a stored Yjs
 * snapshot entirely server-side, so `CreatePageModal` only ever needs to
 * send a `templateId` string, exactly like web's own `<select>` picker.
 * "Templates" opens a small manage sheet (list + delete) — creating one
 * ("save this page as a template") lives on `docs-page/[pageId].tsx`
 * instead, since it needs a `pageId` this screen has no single one of.
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

  const templates = useQuery({
    queryKey: templatesQueryKey(spaceId),
    queryFn: async () => wire(await apiClient.docs.templates.list.query({ spaceId })),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: pagesQueryKey(spaceId) });
  };
  const invalidateTemplates = () => {
    void queryClient.invalidateQueries({ queryKey: templatesQueryKey(spaceId) });
  };

  const [creatingUnder, setCreatingUnder] = useState<string | null>();
  const [newTitle, setNewTitle] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [optionsFor, setOptionsFor] = useState<Page | null>(null);
  const [optionsTitle, setOptionsTitle] = useState('');
  const [movingPage, setMovingPage] = useState<Page | null>(null);
  const [managingTemplates, setManagingTemplates] = useState(false);

  const createPage = useMutation({
    mutationFn: (input: {
      parentPageId: string | null;
      title: string;
      templateId: string | null;
    }) =>
      input.templateId === null
        ? apiClient.docs.pages.create.mutate({
            spaceId,
            parentPageId: input.parentPageId,
            title: input.title,
          })
        : apiClient.docs.templates.createPage.mutate({
            spaceId,
            parentPageId: input.parentPageId,
            title: input.title,
            templateId: input.templateId,
          }),
    onSuccess: () => {
      invalidate();
      setCreatingUnder(undefined);
      setNewTitle('');
      setSelectedTemplateId(null);
    },
    onError: (error: unknown) => {
      Alert.alert('This page could not be created', apiErrorOf(error)?.error.message);
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: (templateId: string) => apiClient.docs.templates.delete.mutate({ templateId }),
    onSettled: invalidateTemplates,
    onError: (error: unknown) => {
      Alert.alert('This template could not be deleted', apiErrorOf(error)?.error.message);
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
        <View style={styles.titleActions}>
          {/* `space:manage` (`docs.templates.delete` reuses it) — this
              button opens the DELETE sheet, so it is hidden entirely for a
              caller who cannot manage the space rather than shown and left
              to answer FORBIDDEN (Phase 15 §1's sweep). Creating a
              template lives on `docs-page/[pageId].tsx` instead, gated the
              same way there. */}
          {space?.capabilities.manage === true && (
            <Pressable
              style={styles.templatesButton}
              onPress={() => {
                setManagingTemplates(true);
              }}
            >
              <Text style={styles.templatesButtonText}>Templates</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.newButton}
            onPress={() => {
              setCreatingUnder(null);
            }}
          >
            <Text style={styles.newButtonText}>+ New page</Text>
          </Pressable>
        </View>
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
              router.push({
                pathname: '/docs-page/[pageId]',
                params: { pageId: item.page.pageId, spaceId },
              });
            }}
            onLongPress={() => {
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
        templates={templates.data ?? []}
        selectedTemplateId={selectedTemplateId}
        onSelectTemplate={setSelectedTemplateId}
        pending={createPage.isPending}
        error={createPage.error}
        onCreate={() => {
          createPage.mutate({
            parentPageId: creatingUnder ?? null,
            title: newTitle.trim(),
            templateId: selectedTemplateId,
          });
        }}
        onClose={() => {
          setCreatingUnder(undefined);
          setNewTitle('');
          setSelectedTemplateId(null);
        }}
      />

      <ManageTemplatesModal
        visible={managingTemplates}
        templates={templates.data ?? []}
        deletePending={deleteTemplate.isPending}
        onDelete={(templateId) => {
          deleteTemplate.mutate(templateId);
        }}
        onClose={() => {
          setManagingTemplates(false);
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
  templates,
  selectedTemplateId,
  onSelectTemplate,
  pending,
  error,
  onCreate,
  onClose,
}: {
  readonly visible: boolean;
  readonly parentTitle: string | null;
  readonly title: string;
  readonly onChangeTitle: (value: string) => void;
  readonly templates: readonly DocTemplate[];
  readonly selectedTemplateId: string | null;
  readonly onSelectTemplate: (templateId: string | null) => void;
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
            {templates.length > 0 && (
              <View style={styles.templateSection}>
                <Text style={styles.templateSectionLabel}>Start from a template</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.templatePickerRow}
                >
                  <Pressable
                    style={[
                      styles.templateChip,
                      selectedTemplateId === null && styles.templateChipActive,
                    ]}
                    onPress={() => {
                      onSelectTemplate(null);
                    }}
                  >
                    <Text
                      style={[
                        styles.templateChipText,
                        selectedTemplateId === null && styles.templateChipTextActive,
                      ]}
                    >
                      Blank page
                    </Text>
                  </Pressable>
                  {templates.map((template) => (
                    <Pressable
                      key={template.templateId}
                      style={[
                        styles.templateChip,
                        selectedTemplateId === template.templateId && styles.templateChipActive,
                      ]}
                      onPress={() => {
                        onSelectTemplate(template.templateId);
                      }}
                    >
                      <Text
                        style={[
                          styles.templateChipText,
                          selectedTemplateId === template.templateId &&
                            styles.templateChipTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {template.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                {selectedTemplateId !== null &&
                  (() => {
                    const selected = templates.find((t) => t.templateId === selectedTemplateId);
                    const hint =
                      selected !== undefined ? (TEMPLATE_HINTS[selected.name] ?? null) : null;
                    return hint !== null ? <Text style={styles.templateHint}>{hint}</Text> : null;
                  })()}
              </View>
            )}
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
            {/* `page:delete` is tuple-shareable per page — `page.capabilities
                .archive` is the server's own answer for THIS page, mirroring
                the "Templates" button above. Hidden entirely for a caller
                with no grant rather than shown and left to answer FORBIDDEN
                (Phase 15 §1's sweep). */}
            {page?.capabilities.archive === true && (
              <Pressable
                style={styles.modalOptionRow}
                disabled={archivePending}
                onPress={onArchive}
              >
                <Text style={styles.modalDangerText}>
                  {page.archivedAt !== null ? 'Restore this page' : 'Archive this page'}
                </Text>
              </Pressable>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ManageTemplatesModal({
  visible,
  templates,
  deletePending,
  onDelete,
  onClose,
}: {
  readonly visible: boolean;
  readonly templates: readonly DocTemplate[];
  readonly deletePending: boolean;
  readonly onDelete: (templateId: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>Templates</Text>
          {templates.length === 0 ? (
            <Text style={styles.modalHint}>
              No templates yet — open a page and tap "Save as template" to create one.
            </Text>
          ) : (
            <ScrollView style={styles.modalList} nestedScrollEnabled>
              {templates.map((template) => (
                <View key={template.templateId} style={styles.templateRow}>
                  <Text style={styles.modalOptionText} numberOfLines={1}>
                    {template.name}
                  </Text>
                  <Pressable
                    disabled={deletePending}
                    onPress={() => {
                      onDelete(template.templateId);
                    }}
                  >
                    <Text style={styles.modalDangerText}>Delete</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
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
  titleActions: {
    flexDirection: 'row',
    gap: 8,
  },
  templatesButton: {
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  templatesButtonText: {
    color: colors.ink.hex,
    fontSize: 12,
    fontWeight: '600',
  },
  templateSection: {
    gap: 6,
    marginTop: 4,
  },
  templateSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  templateHint: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    fontStyle: 'italic',
    marginTop: 2,
  },
  templatePickerRow: {
    flexDirection: 'row',
    maxHeight: 40,
  },
  templateChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    maxWidth: 160,
  },
  templateChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  templateChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  templateChipTextActive: {
    color: colors.accentInk.hex,
  },
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
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
