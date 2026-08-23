import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { formatDistanceToNow } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { PageIdSchema, SpaceIdSchema, type PageId, type SpaceId } from '@taskflow/contracts';
import type * as Y from 'yjs';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useMembers } from '../../../src/lib/use-members.js';
import {
  liveFormatParser,
  parseFormattedText,
  serializeToText,
  type SerializableNode,
} from '../../../src/lib/rich-text-compose.js';
import { useDocPage, type DocPageStatus } from '../../../src/lib/use-doc-page.js';
import {
  pageStartAnchor,
  writeRichTextDocumentToFragment,
  yjsFragmentToRichTextDocument,
} from '../../../src/lib/docs-collab.js';
import { extractMentions, hasPageLink } from '../../../src/lib/docs-page-editor.js';
import type { PendingMention } from '../../../src/lib/message-compose.js';
import { savePdfAndShare } from '../../../src/lib/pdf-save.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { pagesQueryKey, backlinksQueryKey, type Backlink } from '../../../src/lib/docs.js';
import { commentsQueryKey, type DocComment } from '../../../src/lib/docs-comments.js';
import { suggestionsQueryKey, type DocSuggestion } from '../../../src/lib/docs-suggestions.js';

/**
 * A page's live content — reading it, AND now writing it — plus everything
 * else web's Docs feature has: comments, suggestions, backlinks, publish/
 * unpublish, PDF export, and saving the page as a template. Reached by
 * tapping a page row on `docs-space/[spaceId].tsx`. The counterpart of
 * `apps/web/src/features/docs/docs-page.tsx`'s `PagePanel`, with one
 * permanent, structural difference: there is no `useEditor` call anywhere
 * on this screen, and there cannot be — ProseMirror needs a DOM, and React
 * Native has none.
 *
 * `spaceId` arrives as a second route param (`router.push({ pathname,
 * params })`, the same shape `thread/[messageId].tsx` uses for `channelId`)
 * because this screen needs it for two things a `pageId` alone cannot
 * answer: which `docs.pages.list` cache to read this page's title and
 * `publishedAt` from (there is no `pages.get` single-page route), and which
 * space `docs.templates.create` should attach a saved template to.
 *
 * ## What needed a workaround, and what did not
 *
 * Backlinks, publish/unpublish, PDF export, and templates are all fully
 * portable exactly as web implements them — none of the four ever sends or
 * receives rich text from THIS app; the server does all the content work.
 * Comments and suggestions are not: both are anchored to a Yjs
 * `RelativePosition`, which web builds from a live ProseMirror text
 * selection. This app has no selection to build one from, so every
 * comment/suggestion created here is anchored to the PAGE as a whole via
 * `docs-collab.ts`'s `pageStartAnchor` — see that function's own header for
 * why the server accepts this as a perfectly valid anchor. A suggestion's
 * `kind` is restricted to `'insert'` here for the same reason `delete`/
 * `replace` need a real range to make sense of: "delete THIS phrase" is not
 * expressible against a page-level anchor. Listing still shows every kind,
 * including ones created on web — only creation is narrowed.
 *
 * ## Writing — real, but honestly NOT "the same as web"
 *
 * `PageEditor` below is a whole-page markdown-style compose-and-save flow,
 * not live per-keystroke collaboration: tap Edit, the page's current
 * content is serialized to plain text (`serializeToText`) into one big
 * `MarkdownTextInput`, and Save replaces the page's ENTIRE content with
 * the re-parsed result (`parseFormattedText` → `writeRichTextDocumentToFragment`)
 * as one real Yjs update — which DOES sync to every other connected
 * client, web included, the moment it lands. What it does not have: a
 * live cursor, character-by-character sync while composing, or a true
 * operational merge with someone editing at the same time — Save compares
 * the page's CURRENT content against what this screen captured when
 * editing started, and warns before overwriting a genuine concurrent
 * change, rather than silently discarding it.
 *
 * A page containing a `pageLink` node cannot round-trip through this —
 * `rich-text-compose.ts`'s own header on `serializeToText` is explicit
 * that a page link degrades to plain text with no way back — so `Edit`
 * warns and asks before entering edit mode on one, rather than losing a
 * page's internal links silently on the next Save.
 *
 * Nothing here re-derives authorization (CLAUDE.md §8.2). Every button
 * (Edit, Publish, Export, comment/suggestion actions) is always shown; the
 * server answers, exactly as `card/[cardId].tsx`'s own sections do — a
 * viewer with no `page:update` still sees "Edit", and a save attempt comes
 * back FORBIDDEN rather than the control being hidden.
 */
export default function DocsPageScreen() {
  const params = useLocalSearchParams<{ pageId: string; spaceId: string }>();
  const parsedPageId = PageIdSchema.safeParse(params.pageId);
  const parsedSpaceId = SpaceIdSchema.safeParse(params.spaceId);

  if (!parsedPageId.success || !parsedSpaceId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.sectionEmptyHint}>This page link isn't valid.</Text>
        <Pressable
          style={styles.backButton}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </Pressable>
      </View>
    );
  }

  return <DocsPageContent pageId={parsedPageId.data} spaceId={parsedSpaceId.data} />;
}

function DocsPageContent({
  pageId,
  spaceId,
}: {
  readonly pageId: PageId;
  readonly spaceId: SpaceId;
}) {
  const orgId = useSession((state) => state.orgId);
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();

  const { doc, status, synced } = useDocPage(orgId, pageId);

  const [hasEverSynced, setHasEverSynced] = useState(synced);
  useEffect(() => {
    if (synced) setHasEverSynced(true);
  }, [synced]);

  /* `editing` gates which of `PageContent` (read-only) or `PageEditor`
     (compose-and-save) renders below — never both. `baselineText` is
     captured once, the moment Edit is pressed, and compared against the
     page's CURRENT content at Save time: this screen has no live
     per-keystroke sync while composing (this file's own header explains
     why), so that comparison is the one thing standing between "someone
     else's edit landed while I was typing" and silently overwriting it. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftMentions, setDraftMentions] = useState<readonly PendingMention[]>([]);
  const [baselineText, setBaselineText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEditing = (): void => {
    if (doc === null) return;
    const current = yjsFragmentToRichTextDocument(doc.getXmlFragment('content'));
    const beginEditing = (): void => {
      const text = serializeToText(current as { readonly content: readonly SerializableNode[] });
      setDraft(text);
      setBaselineText(text);
      setDraftMentions(extractMentions(current));
      setSaveError(null);
      setEditing(true);
    };

    if (hasPageLink(current)) {
      Alert.alert(
        'This page has links to other pages',
        'Editing here cannot preserve them — saving will turn them into plain text. Continue anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', style: 'destructive', onPress: beginEditing },
        ],
      );
      return;
    }
    beginEditing();
  };

  const saveEdit = (overwrite: boolean): void => {
    if (doc === null) return;
    const fragment = doc.getXmlFragment('content');
    const current = yjsFragmentToRichTextDocument(fragment);
    const currentText = serializeToText(
      current as { readonly content: readonly SerializableNode[] },
    );

    if (!overwrite && currentText !== baselineText) {
      Alert.alert(
        'This page changed since you started editing',
        'Someone else’s changes are on the page now. Save anyway and overwrite them, or go back and re-check?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Overwrite',
            style: 'destructive',
            onPress: () => {
              saveEdit(true);
            },
          },
        ],
      );
      return;
    }

    try {
      writeRichTextDocumentToFragment(fragment, parseFormattedText(draft, draftMentions));
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'This page could not be saved.');
    }
  };

  const pages = useQuery({
    queryKey: pagesQueryKey(spaceId),
    queryFn: async () => wire(await apiClient.docs.pages.list.query({ spaceId })),
  });
  const page = pages.data?.find((entry) => entry.pageId === pageId);

  const invalidatePages = () => queryClient.invalidateQueries({ queryKey: pagesQueryKey(spaceId) });

  const publish = useMutation({
    mutationFn: () => apiClient.docs.pages.publish.mutate({ pageId }),
    onSuccess: invalidatePages,
    onError: (error: unknown) => {
      Alert.alert('This page could not be published', apiErrorOf(error)?.error.message);
    },
  });

  const unpublish = useMutation({
    mutationFn: () => apiClient.docs.pages.unpublish.mutate({ pageId }),
    onSuccess: invalidatePages,
    onError: (error: unknown) => {
      Alert.alert('This page could not be unpublished', apiErrorOf(error)?.error.message);
    },
  });

  const exportPdf = useMutation({
    mutationFn: async () => {
      const result = await apiClient.docs.pages.exportPdf.mutate({
        pageId,
        versionId: null,
      });
      await savePdfAndShare(result.filename, result.contentBase64);
    },
    onError: (error: unknown) => {
      Alert.alert('This page could not be exported', apiErrorOf(error)?.error.message);
    },
  });

  const [savingTemplate, setSavingTemplate] = useState(false);

  const saveTemplate = useMutation({
    mutationFn: (name: string) => apiClient.docs.templates.create.mutate({ pageId, name }),
    onSuccess: () => {
      setSavingTemplate(false);
    },
    onError: (error: unknown) => {
      Alert.alert('This template could not be saved', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable
          style={styles.backButton}
          onPress={() => {
            router.back();
          }}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </Pressable>
        {/* A second row, below the back button — never beside it. See
            git history / README for the live-found reason: top-bar.tsx's
            fixed Account/notification overlay draws over anything sharing
            its row. */}
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {page?.title ?? 'Page'}
          </Text>
          <ConnectionPill status={status} synced={synced} />
        </View>

        <View style={styles.actionsRow}>
          {!editing && (
            <Pressable style={styles.actionButton} disabled={doc === null} onPress={startEditing}>
              <Text style={styles.actionButtonText}>Edit</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.actionButton}
            disabled={publish.isPending || unpublish.isPending}
            onPress={() => {
              if (page?.publishedAt !== null && page?.publishedAt !== undefined) {
                unpublish.mutate();
              } else {
                publish.mutate();
              }
            }}
          >
            {publish.isPending || unpublish.isPending ? (
              <ActivityIndicator size="small" color={colors.ink.hex} />
            ) : (
              <Text style={styles.actionButtonText}>
                {page?.publishedAt !== null && page?.publishedAt !== undefined
                  ? 'Unpublish'
                  : 'Publish'}
              </Text>
            )}
          </Pressable>
          <Pressable
            style={styles.actionButton}
            disabled={exportPdf.isPending}
            onPress={() => {
              exportPdf.mutate();
            }}
          >
            {exportPdf.isPending ? (
              <ActivityIndicator size="small" color={colors.ink.hex} />
            ) : (
              <Text style={styles.actionButtonText}>Export PDF</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.actionButton}
            onPress={() => {
              setSavingTemplate(true);
            }}
          >
            <Text style={styles.actionButtonText}>Save as template</Text>
          </Pressable>
        </View>
        {page?.publishedAt !== null && page?.publishedAt !== undefined && (
          <Text style={styles.publishedHint}>
            Published {formatDistanceToNow(new Date(page.publishedAt), { addSuffix: true })}
          </Text>
        )}

        {!hasEverSynced ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent.hex} />
            <Text style={styles.loadingHint}>
              {status === 'disconnected' ? 'Reconnecting…' : 'Connecting…'}
            </Text>
          </View>
        ) : doc === null ? null : editing ? (
          <PageEditor
            draft={draft}
            onDraftChange={setDraft}
            error={saveError}
            onSave={() => {
              saveEdit(false);
            }}
            onCancel={() => {
              setEditing(false);
              setSaveError(null);
            }}
          />
        ) : (
          <PageContent doc={doc} />
        )}

        <CommentsSection pageId={pageId} doc={doc} />
        <SuggestionsSection pageId={pageId} doc={doc} />
        <BacklinksSection pageId={pageId} />
      </ScrollView>

      <SaveTemplateModal
        visible={savingTemplate}
        pending={saveTemplate.isPending}
        onSave={(name) => {
          saveTemplate.mutate(name);
        }}
        onClose={() => {
          setSavingTemplate(false);
        }}
      />
    </KeyboardAvoidingView>
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

  return <RichTextView document={document} />;
}

/**
 * The compose-and-save half — see this screen's own header for the "real
 * writing, not live collaboration" scope this represents. `liveFormatParser`
 * is the SAME live-highlighting worklet `CommentsSection`'s composer uses,
 * now doing real work on a much longer draft: headings, blockquotes, lists,
 * and fenced code all stay plain text until Save (block structure has no
 * character-range representation `MarkdownTextInput` can highlight — that
 * file's own header explains why), but every inline mark highlights live.
 */
function PageEditor({
  draft,
  onDraftChange,
  error,
  onSave,
  onCancel,
}: {
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly error: string | null;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <View style={styles.editorContainer}>
      <MarkdownTextInput
        value={draft}
        onChangeText={onDraftChange}
        placeholder="Write the page…"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.editorInput}
        multiline
        autoFocus
        parser={liveFormatParser}
        markdownStyle={{
          syntax: { color: colors.inkFaint.hex },
          link: { color: colors.accent.hex },
        }}
      />
      {error !== null && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {error}
        </Text>
      )}
      <View style={styles.editorActions}>
        <Pressable style={styles.actionButton} onPress={onCancel}>
          <Text style={styles.actionButtonText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.editorSaveButton} onPress={onSave}>
          <Text style={styles.editorSaveButtonText}>Save</Text>
        </Pressable>
      </View>
    </View>
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

/**
 * Flat — no reply threading, matching `docs.comments.list`'s own output
 * schema (no `parentCommentId` field) and web's `CommentsTab`, which
 * renders one flat list too.
 */
function CommentsSection({ pageId, doc }: { readonly pageId: string; readonly doc: Y.Doc | null }) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const comments = useQuery({
    queryKey: commentsQueryKey(pageId),
    queryFn: async () => wire(await apiClient.docs.comments.list.query({ pageId })),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: commentsQueryKey(pageId) });

  const post = useMutation({
    mutationFn: (body: string) => {
      if (doc === null) throw new Error('Not connected yet.');
      const { anchorFrom, anchorTo } = pageStartAnchor(doc.getXmlFragment('content'));
      return apiClient.docs.comments.create.mutate({
        pageId,
        anchorFrom,
        anchorTo,
        body: parseFormattedText(body),
      });
    },
    onSuccess: () => {
      setDraft('');
    },
    onSettled: invalidate,
  });

  const edit = useMutation({
    mutationFn: (input: { commentId: string; text: string }) =>
      apiClient.docs.comments.update.mutate({
        commentId: input.commentId,
        body: parseFormattedText(input.text),
      }),
    onSuccess: () => {
      setEditingId(null);
    },
    onSettled: invalidate,
  });

  const resolve = useMutation({
    mutationFn: (input: { commentId: string; resolved: boolean }) =>
      apiClient.docs.comments.resolve.mutate(input),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (commentId: string) => apiClient.docs.comments.delete.mutate({ commentId }),
    onSettled: invalidate,
  });

  const rows = (comments.data ?? []).filter((comment) => comment.deletedAt === null);

  return (
    <Section label="Comments">
      {comments.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {rows.map((comment) => (
        <CommentRow
          key={comment.commentId}
          comment={comment}
          viewerId={userId}
          personOf={personOf}
          isEditing={editingId === comment.commentId}
          editDraft={editDraft}
          onEditDraftChange={setEditDraft}
          editPending={edit.isPending}
          onStartEdit={() => {
            setEditingId(comment.commentId);
            setEditDraft(comment.bodyText);
          }}
          onCancelEdit={() => {
            setEditingId(null);
          }}
          onSaveEdit={() => {
            if (editDraft.trim().length === 0) return;
            edit.mutate({ commentId: comment.commentId, text: editDraft.trim() });
          }}
          onToggleResolve={() => {
            resolve.mutate({ commentId: comment.commentId, resolved: comment.resolvedAt === null });
          }}
          onDelete={() => {
            remove.mutate(comment.commentId);
          }}
        />
      ))}
      {rows.length === 0 && !comments.isPending && (
        <Text style={styles.sectionEmptyHint}>No comments yet.</Text>
      )}

      <View style={styles.composerRow}>
        <MarkdownTextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={doc === null ? 'Connecting…' : 'Add a comment…'}
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
          editable={doc !== null}
          parser={liveFormatParser}
          markdownStyle={{
            syntax: { color: colors.inkFaint.hex },
            link: { color: colors.accent.hex },
          }}
        />
        <Pressable
          style={styles.sendButton}
          disabled={draft.trim().length === 0 || doc === null || post.isPending}
          onPress={() => {
            post.mutate(draft.trim());
          }}
        >
          {post.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </Pressable>
      </View>
      {(post.isError || edit.isError || remove.isError) && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(post.error ?? edit.error ?? remove.error)?.error.message ??
            'That action could not be completed.'}
        </Text>
      )}
    </Section>
  );
}

function CommentRow({
  comment,
  viewerId,
  personOf,
  isEditing,
  editDraft,
  onEditDraftChange,
  editPending,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleResolve,
  onDelete,
}: {
  readonly comment: DocComment;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly isEditing: boolean;
  readonly editDraft: string;
  readonly onEditDraftChange: (text: string) => void;
  readonly editPending: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: () => void;
  readonly onToggleResolve: () => void;
  readonly onDelete: () => void;
}) {
  const isOwn = comment.authorId === viewerId;
  const author =
    comment.authorId === null ? 'Unknown' : isOwn ? 'You' : personOf(comment.authorId).label;

  return (
    <View style={[styles.itemRow, comment.resolvedAt !== null && styles.itemRowResolved]}>
      <View style={styles.itemMeta}>
        <Text style={styles.itemAuthor}>{author}</Text>
        <Text style={styles.itemTime}>
          {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
        </Text>
        {comment.editedAt !== null && <Text style={styles.itemTime}>(edited)</Text>}
        {comment.resolvedAt !== null && <Text style={styles.resolvedBadge}>Resolved</Text>}
      </View>

      {isEditing ? (
        <View style={styles.editRow}>
          <MarkdownTextInput
            value={editDraft}
            onChangeText={onEditDraftChange}
            style={styles.editInput}
            multiline
            autoFocus
            parser={liveFormatParser}
            markdownStyle={{
              syntax: { color: colors.inkFaint.hex },
              link: { color: colors.accent.hex },
            }}
          />
          <View style={styles.editActions}>
            <Pressable onPress={onCancelEdit}>
              <Text style={styles.editCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.editSaveButton}
              disabled={editPending || editDraft.trim().length === 0}
              onPress={onSaveEdit}
            >
              {editPending ? (
                <ActivityIndicator color={colors.accentInk.hex} />
              ) : (
                <Text style={styles.editSaveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <RichTextView document={comment.body} />
          <View style={styles.itemActions}>
            {isOwn && (
              <Pressable onPress={onStartEdit}>
                <Text style={styles.itemActionText}>Edit</Text>
              </Pressable>
            )}
            <Pressable onPress={onToggleResolve}>
              <Text style={styles.itemActionText}>
                {comment.resolvedAt !== null ? 'Reopen' : 'Resolve'}
              </Text>
            </Pressable>
            <Pressable onPress={onDelete}>
              <Text style={styles.itemActionText}>Delete</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const SUGGESTION_KIND_LABEL: Record<string, string> = {
  insert: 'Addition',
  delete: 'Removal',
  replace: 'Replacement',
};

/**
 * Listing shows every suggestion kind (a `delete`/`replace` created on web
 * is still shown here); creating one on this screen only ever proposes an
 * `insert` — see this file's own header for why the other two kinds need a
 * real text range to mean anything.
 */
function SuggestionsSection({
  pageId,
  doc,
}: {
  readonly pageId: string;
  readonly doc: Y.Doc | null;
}) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const [draft, setDraft] = useState('');

  const suggestions = useQuery({
    queryKey: suggestionsQueryKey(pageId),
    queryFn: async () => wire(await apiClient.docs.suggestions.list.query({ pageId })),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: suggestionsQueryKey(pageId) });

  const propose = useMutation({
    mutationFn: (note: string) => {
      if (doc === null) throw new Error('Not connected yet.');
      const { anchorFrom, anchorTo } = pageStartAnchor(doc.getXmlFragment('content'));
      return apiClient.docs.suggestions.create.mutate({
        pageId,
        anchorFrom,
        anchorTo,
        kind: 'insert',
        proposedContent: parseFormattedText(note),
      });
    },
    onSuccess: () => {
      setDraft('');
    },
    onSettled: invalidate,
  });

  const decide = useMutation({
    mutationFn: (input: { suggestionId: string; status: 'accepted' | 'rejected' }) =>
      apiClient.docs.suggestions.decide.mutate(input),
    onSettled: invalidate,
  });

  const rows = suggestions.data ?? [];

  return (
    <Section label="Suggestions">
      {suggestions.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {rows.map((suggestion) => (
        <SuggestionRow
          key={suggestion.suggestionId}
          suggestion={suggestion}
          viewerId={userId}
          personOf={personOf}
          decidePending={decide.isPending}
          onAccept={() => {
            decide.mutate({ suggestionId: suggestion.suggestionId, status: 'accepted' });
          }}
          onReject={() => {
            decide.mutate({ suggestionId: suggestion.suggestionId, status: 'rejected' });
          }}
        />
      ))}
      {rows.length === 0 && !suggestions.isPending && (
        <Text style={styles.sectionEmptyHint}>No suggestions yet.</Text>
      )}

      <View style={styles.composerRow}>
        <MarkdownTextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={doc === null ? 'Connecting…' : 'Propose an addition…'}
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
          editable={doc !== null}
          parser={liveFormatParser}
          markdownStyle={{
            syntax: { color: colors.inkFaint.hex },
            link: { color: colors.accent.hex },
          }}
        />
        <Pressable
          style={styles.sendButton}
          disabled={draft.trim().length === 0 || doc === null || propose.isPending}
          onPress={() => {
            propose.mutate(draft.trim());
          }}
        >
          {propose.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.sendButtonText}>Propose</Text>
          )}
        </Pressable>
      </View>
      {(propose.isError || decide.isError) && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(propose.error ?? decide.error)?.error.message ??
            'That action could not be completed.'}
        </Text>
      )}
    </Section>
  );
}

function SuggestionRow({
  suggestion,
  viewerId,
  personOf,
  decidePending,
  onAccept,
  onReject,
}: {
  readonly suggestion: DocSuggestion;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly decidePending: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}) {
  const isOwn = suggestion.authorId === viewerId;
  const author =
    suggestion.authorId === null ? 'Unknown' : isOwn ? 'You' : personOf(suggestion.authorId).label;

  return (
    <View style={styles.itemRow}>
      <View style={styles.itemMeta}>
        <Text style={styles.itemAuthor}>{author}</Text>
        <Text style={styles.kindBadge}>
          {SUGGESTION_KIND_LABEL[suggestion.kind] ?? suggestion.kind}
        </Text>
        <Text style={styles.itemTime}>
          {formatDistanceToNow(new Date(suggestion.createdAt), { addSuffix: true })}
        </Text>
        <Text
          style={[
            styles.statusBadge,
            suggestion.status === 'accepted' && styles.statusBadgeAccepted,
            suggestion.status === 'rejected' && styles.statusBadgeRejected,
          ]}
        >
          {suggestion.status}
        </Text>
      </View>

      {suggestion.proposedContent !== null && (
        <RichTextView document={suggestion.proposedContent} />
      )}

      {suggestion.status === 'pending' && (
        <View style={styles.itemActions}>
          <Pressable disabled={decidePending} onPress={onAccept}>
            <Text style={styles.itemActionText}>Accept</Text>
          </Pressable>
          <Pressable disabled={decidePending} onPress={onReject}>
            <Text style={styles.itemActionText}>Reject</Text>
          </Pressable>
        </View>
      )}
      {suggestion.status === 'accepted' && (
        <Text style={styles.sectionEmptyHint}>
          Accepted — apply the change in the document yourself.
        </Text>
      )}
    </View>
  );
}

function BacklinksSection({ pageId }: { readonly pageId: string }) {
  const backlinks = useQuery({
    queryKey: backlinksQueryKey(pageId),
    queryFn: async () => wire(await apiClient.docs.backlinks.list.query({ pageId })),
  });

  const rows = backlinks.data ?? [];

  return (
    <Section label="Backlinks">
      {backlinks.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {rows.map((link: Backlink) => (
        <Pressable
          key={link.sourcePageId}
          style={styles.backlinkRow}
          onPress={() => {
            router.push({
              pathname: '/docs-page/[pageId]',
              params: { pageId: link.sourcePageId, spaceId: link.sourceSpaceId },
            });
          }}
        >
          <Text style={styles.backlinkText} numberOfLines={1}>
            {link.sourceTitle}
          </Text>
        </Pressable>
      ))}
      {rows.length === 0 && !backlinks.isPending && (
        <Text style={styles.sectionEmptyHint}>Nothing links here yet.</Text>
      )}
    </Section>
  );
}

function SaveTemplateModal({
  visible,
  pending,
  onSave,
  onClose,
}: {
  readonly visible: boolean;
  readonly pending: boolean;
  readonly onSave: (name: string) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState('');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onShow={() => {
        setName('');
      }}
    >
      <KeyboardAvoidingView
        style={styles.avoider}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.modalBackdrop} onPress={onClose}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Save as template</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Template name"
              placeholderTextColor={colors.inkFaint.hex}
              value={name}
              onChangeText={setName}
              maxLength={200}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable
                style={[
                  styles.modalPrimaryButton,
                  (pending || name.trim() === '') && styles.buttonDisabled,
                ]}
                disabled={pending || name.trim() === ''}
                onPress={() => {
                  onSave(name.trim());
                }}
              >
                <Text style={styles.modalPrimaryButtonText}>Save</Text>
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

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
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
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  actionButton: {
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    minWidth: 44,
    alignItems: 'center',
  },
  actionButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  publishedHint: {
    fontSize: 11,
    color: colors.inkFaint.hex,
    marginBottom: 14,
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
  editorContainer: {
    gap: 10,
  },
  editorInput: {
    minHeight: 220,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
    textAlignVertical: 'top',
  },
  editorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  editorSaveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
  },
  editorSaveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '700',
  },
  section: {
    marginTop: 28,
    gap: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sectionEmptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  itemRow: {
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
    paddingBottom: 10,
  },
  itemRowResolved: {
    opacity: 0.6,
  },
  itemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  itemAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  itemTime: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  itemActions: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 2,
  },
  itemActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  resolvedBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.success.hex,
  },
  kindBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    backgroundColor: colors.surfaceHover.hex,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.inkFaint.hex,
    textTransform: 'capitalize',
  },
  statusBadgeAccepted: {
    color: colors.success.hex,
  },
  statusBadgeRejected: {
    color: colors.danger.hex,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 14,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '700',
  },
  editRow: {
    gap: 8,
  },
  editInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surface.hex,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
  },
  editCancelText: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  editSaveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  editSaveText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '700',
  },
  backlinkRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  backlinkText: {
    fontSize: 14,
    color: colors.accent.hex,
    fontWeight: '600',
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
});
