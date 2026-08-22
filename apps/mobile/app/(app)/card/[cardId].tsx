import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { CardIdSchema, type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { plainParagraph } from '@taskflow/api/richtext';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { useUpdateCard } from '../../../src/lib/use-update-card.js';
import { useMembers, type Member } from '../../../src/lib/use-members.js';
import { pickAttachment } from '../../../src/lib/pick-attachment.js';
import { uploadCardAttachment } from '../../../src/lib/upload-card-attachment.js';
import {
  CUSTOM_FIELD_TYPES,
  MY_TASKS_QUERY_KEY,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  attachmentsQueryKey,
  boardCardsQueryKey,
  cardFieldsQueryKey,
  cardLabelsQueryKey,
  cardQueryKey,
  checklistsQueryKey,
  commentsQueryKey,
  fieldsQueryKey,
  formatBytes,
  formatDueDate,
  labelsQueryKey,
  nextLabelColor,
  statusesQueryKey,
  type CardDetail,
  type Checklist,
  type Comment,
  type CustomFieldType,
  type Priority,
} from '../../../src/lib/work.js';
import { isOpenSprint, sprintsQueryKey } from '../../../src/lib/sprints.js';

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * Card detail (Wave 2's second slice, following "My Tasks", then made
 * editable as Wave 2's "optimistic mutations" roadmap item —
 * `ai/phase-14-mobile.md`). Title, priority, sprint, status, assignees and
 * labels are all editable now — the Work-parity pass following My Tasks
 * and Boards closed status/assignees/labels, the three "vocabulary"
 * sections a systematic audit against `apps/web/src/features/work/
 * detail/*.tsx` found completely absent. Checklist items, custom fields,
 * attachments and comment edit/delete are still read/post-only or
 * missing — see each section's own header below for exactly why.
 *
 * **`StatusSelector`/`AssigneeSelector`/`LabelSelector` each mirror their
 * web counterpart's own authorization split rather than re-deriving it**:
 * status and priority are two different mutations because the SERVICE
 * treats them as two different things (`cards.setStatus` emits its own
 * domain event; priority rides `cards.update`); tagging a card
 * (`card:update`) and managing the project's label vocabulary
 * (`project:update`) are two different permissions the UI shows to
 * everyone and lets the server adjudicate (CLAUDE.md §8.2) — never a
 * client-side role check.
 *
 * `KeyboardAvoidingView` wraps the whole `ScrollView` — added after a real
 * device run showed `CommentsSection`'s composer with no keyboard handling
 * at all rendering fully behind the keyboard, same failure `channel/
 * [channelId].tsx`'s composer had (see that file's own header for why
 * `'height'`, not `undefined`, is the Android behavior).
 *
 * Nested under `(app)/` — not the root, unlike `org-picker.tsx` — because a
 * card genuinely needs an org selected to mean anything; `(app)/_layout.tsx`'s
 * gate is exactly the check this screen wants inherited, not re-implemented.
 *
 * `cardId` is parsed through `CardIdSchema` before anything queries with
 * it — the URL is a trust boundary on native exactly as apps/web's own
 * router treats it (CLAUDE.md's Phase 3 section, `use-board-room.ts`'s
 * identical parse at the identical boundary). A malformed id — a stale deep
 * link, a manually typed URL in a dev client — falls back to a safe "not
 * found" screen rather than reaching a query with an unbranded string.
 *
 * A manual back button, not the native header `(app)/_layout.tsx`'s
 * `<Stack>` could show for free — `headerShown: false` there keeps that
 * chrome off everywhere, matching every other screen's own manual
 * `Pressable` back button for visual consistency, even though the STACK
 * itself is now real (see that layout's own header for why it has to be).
 */
export default function CardDetail() {
  const params = useLocalSearchParams<{ cardId: string }>();
  const parsedCardId = CardIdSchema.safeParse(params.cardId);

  if (!parsedCardId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This card link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <CardDetailContent cardId={parsedCardId.data} />;
}

function CardDetailContent({ cardId }: { cardId: CardId }) {
  const card = useQuery({
    queryKey: cardQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.cards.get.query({ cardId })),
  });

  const [saveError, setSaveError] = useState<unknown>(null);
  const update = useUpdateCard(cardId, (_title, error) => {
    setSaveError(error);
  });
  const paddingTop = useTopInset();

  if (card.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  if (card.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(card.error)?.error.message ?? "Couldn't load this card."}
        </Text>
        <BackButton />
      </View>
    );
  }

  const data = card.data;
  const due = formatDueDate(data.dueDate);
  const checklistDone = data.checklistTotal > 0 && data.checklistDone === data.checklistTotal;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop }]}>
        <BackButton />
        <Text style={styles.reference}>{data.reference}</Text>

        <TitleField
          key={cardId}
          card={data}
          onSave={(title) => {
            update.mutate({ title });
          }}
        />

        <StatusSelector cardId={cardId} projectId={data.projectId} statusId={data.statusId} />

        <PrioritySelector
          value={data.priority}
          onChange={(priority) => {
            setSaveError(null);
            update.mutate({ priority });
          }}
        />

        <AssigneeSelector cardId={cardId} assigneeIds={data.assigneeIds} />

        <SprintSelector cardId={cardId} projectId={data.projectId} sprintId={data.sprintId} />

        <LabelSelector cardId={cardId} projectId={data.projectId} />

        <CustomFieldSection cardId={cardId} projectId={data.projectId} />

        {saveError !== null && (
          <Text style={styles.error} accessibilityRole="alert">
            {apiErrorOf(saveError)?.error.message ?? 'The card was not saved.'}
          </Text>
        )}

        <View style={styles.badgeRow}>
          {due !== null && (
            <View style={[styles.badge, due.overdue && styles.badgeOverdue]}>
              <Text style={[styles.badgeText, due.overdue && styles.badgeOverdueText]}>
                {due.label}
              </Text>
            </View>
          )}
          {data.checklistTotal > 0 && (
            <View style={styles.badge}>
              <Text style={[styles.badgeText, checklistDone && styles.badgeDoneText]}>
                {data.checklistDone}/{data.checklistTotal}
              </Text>
            </View>
          )}
          {data.commentCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>💬 {data.commentCount}</Text>
            </View>
          )}
        </View>

        <RichTextView document={data.description} />

        <ChecklistSection cardId={cardId} boardId={data.boardId} />

        <AttachmentSection cardId={cardId} />

        <CommentsSection cardId={cardId} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Checklists on a card — `apps/web`'s `ChecklistSection`, the first
 * interactive checklist on native (`card-row.tsx`'s own badge, and the
 * badge row above, have always been COUNT-only, `checklistDone/
 * checklistTotal` read straight off `CardDetail`/`CardSummary`).
 *
 * **Every mutation invalidates the card AND the board's card list, not
 * just the checklist query** — ticking an item changes `checklistDone`/
 * `checklistTotal`, which both `card/[cardId].tsx`'s own badge row and
 * `board/[boardId].tsx`'s `CardRow` render. The server RECOMPUTES those
 * counters inside the writing transaction rather than incrementing them
 * (`counters.ts`), precisely so the number is never a guess — a client
 * that forgot to refetch would undo that by showing a stale one, and a
 * wrong badge looks exactly like a correct one. _(The same staleness this
 * comment fixes for checklists still applies to status/priority/
 * assignees/labels/sprint above: those sections predate `board/
 * [boardId].tsx` rendering `CardRow` at all, from back when `use-update-
 * card.ts`'s own header could honestly say "mobile has no board view
 * yet." That claim is no longer true and none of those five sections'
 * invalidation sets were widened to match — a real, separate follow-up,
 * named here rather than silently left for whoever next touches one of
 * them to rediscover.)_
 *
 * **Adding a checklist or an item is NOT optimistic; ticking and deleting
 * ARE** — matching web's own split exactly, for the same reason: an item
 * id comes from the server, and a row that cannot be deleted until the
 * refetch lands is worse than one that appears a moment late (the same
 * "no fake reference" call `board/[boardId].tsx`'s own Add Card makes).
 * Ticking a box, though, has to be instant — a checkbox that waits for a
 * round trip is the canonical "this app feels slow" — so `toggleItem`
 * patches the checklist query directly before the mutation resolves, and
 * rolls back to the snapshot on failure.
 */
function ChecklistSection({
  cardId,
  boardId,
}: {
  readonly cardId: CardId;
  readonly boardId: string;
}) {
  const queryClient = useQueryClient();
  const [newChecklistName, setNewChecklistName] = useState('');
  const [addingItemFor, setAddingItemFor] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState('');

  const checklists = useQuery({
    queryKey: checklistsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.checklists.list.query({ cardId })),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: checklistsQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) }),
      queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
    ]);

  const createChecklist = useMutation({
    mutationFn: (name: string) => apiClient.work.checklists.create.mutate({ cardId, name }),
    onSuccess: () => {
      setNewChecklistName('');
    },
    onSettled: refresh,
  });

  const deleteChecklist = useMutation({
    mutationFn: (checklistId: string) => apiClient.work.checklists.delete.mutate({ checklistId }),
    onSettled: refresh,
  });

  const toggleItem = useMutation({
    mutationFn: (input: { itemId: string; text: string; done: boolean }) =>
      apiClient.work.checklists.updateItem.mutate(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: checklistsQueryKey(cardId) });
      const previous = queryClient.getQueryData<readonly Checklist[]>(checklistsQueryKey(cardId));
      queryClient.setQueryData<readonly Checklist[]>(checklistsQueryKey(cardId), (current) =>
        (current ?? []).map((checklist) => ({
          ...checklist,
          items: checklist.items.map((item) =>
            item.itemId === input.itemId ? { ...item, done: input.done } : item,
          ),
        })),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context !== undefined) {
        queryClient.setQueryData(checklistsQueryKey(cardId), context.previous);
      }
    },
    onSettled: refresh,
  });

  const addItem = useMutation({
    mutationFn: (input: { checklistId: string; text: string }) =>
      apiClient.work.checklists.addItem.mutate(input),
    onSuccess: () => {
      setNewItemText('');
      setAddingItemFor(null);
    },
    onSettled: refresh,
  });

  const deleteItem = useMutation({
    mutationFn: (itemId: string) => apiClient.work.checklists.deleteItem.mutate({ itemId }),
    onMutate: async (itemId) => {
      await queryClient.cancelQueries({ queryKey: checklistsQueryKey(cardId) });
      const previous = queryClient.getQueryData<readonly Checklist[]>(checklistsQueryKey(cardId));
      queryClient.setQueryData<readonly Checklist[]>(checklistsQueryKey(cardId), (current) =>
        (current ?? []).map((checklist) => ({
          ...checklist,
          items: checklist.items.filter((item) => item.itemId !== itemId),
        })),
      );
      return { previous };
    },
    onError: (_error, _itemId, context) => {
      if (context !== undefined) {
        queryClient.setQueryData(checklistsQueryKey(cardId), context.previous);
      }
    },
    onSettled: refresh,
  });

  const anyError =
    createChecklist.error ??
    deleteChecklist.error ??
    toggleItem.error ??
    addItem.error ??
    deleteItem.error;

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Checklists</Text>

      {(checklists.data ?? []).map((checklist) => {
        const done = checklist.items.filter((item) => item.done).length;
        return (
          <View key={checklist.checklistId} style={styles.checklistGroup}>
            <View style={styles.checklistHeader}>
              <Text style={styles.checklistName}>{checklist.name}</Text>
              <Text style={styles.checklistCount}>
                {done}/{checklist.items.length}
              </Text>
              <Pressable
                style={styles.checklistDeleteButton}
                onPress={() => {
                  deleteChecklist.mutate(checklist.checklistId);
                }}
              >
                <Text style={styles.checklistDeleteText}>Delete</Text>
              </Pressable>
            </View>

            {checklist.items.map((item) => (
              <View key={item.itemId} style={styles.checklistItemRow}>
                <Pressable
                  style={[styles.checklistBox, item.done && styles.checklistBoxDone]}
                  onPress={() => {
                    toggleItem.mutate({ itemId: item.itemId, text: item.text, done: !item.done });
                  }}
                >
                  {item.done && <Text style={styles.checklistBoxCheck}>✓</Text>}
                </Pressable>
                <Text style={[styles.checklistItemText, item.done && styles.checklistItemTextDone]}>
                  {item.text}
                </Text>
                <Pressable
                  onPress={() => {
                    deleteItem.mutate(item.itemId);
                  }}
                  hitSlop={8}
                >
                  <Text style={styles.checklistItemRemove}>✕</Text>
                </Pressable>
              </View>
            ))}

            {addingItemFor === checklist.checklistId ? (
              <View style={styles.addCardRow}>
                <TextInput
                  style={styles.addCardInput}
                  placeholder="Add an item"
                  placeholderTextColor={colors.inkFaint.hex}
                  value={newItemText}
                  onChangeText={setNewItemText}
                  autoFocus
                  onSubmitEditing={() => {
                    const value = newItemText.trim();
                    if (value === '') return;
                    addItem.mutate({ checklistId: checklist.checklistId, text: value });
                  }}
                />
                <Pressable
                  style={styles.addCardButton}
                  disabled={addItem.isPending}
                  onPress={() => {
                    const value = newItemText.trim();
                    if (value === '') return;
                    addItem.mutate({ checklistId: checklist.checklistId, text: value });
                  }}
                >
                  <Text style={styles.addCardButtonText}>Add</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                onPress={() => {
                  setNewItemText('');
                  setAddingItemFor(checklist.checklistId);
                }}
              >
                <Text style={styles.checklistAddItemText}>+ Add an item</Text>
              </Pressable>
            )}
          </View>
        );
      })}

      <View style={styles.addCardRow}>
        <TextInput
          style={styles.addCardInput}
          placeholder="New checklist"
          placeholderTextColor={colors.inkFaint.hex}
          value={newChecklistName}
          onChangeText={setNewChecklistName}
          onSubmitEditing={() => {
            const value = newChecklistName.trim();
            if (value !== '') createChecklist.mutate(value);
          }}
        />
        <Pressable
          style={styles.addCardButton}
          disabled={createChecklist.isPending || newChecklistName.trim().length === 0}
          onPress={() => {
            const value = newChecklistName.trim();
            if (value !== '') createChecklist.mutate(value);
          }}
        >
          <Text style={styles.addCardButtonText}>Add</Text>
        </Pressable>
      </View>

      {anyError !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(anyError)?.error.message ?? 'The checklist was not saved.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Comments — read + post only, no edit/delete/replies. `work.comments.list`
 * shares TipTap-JSON's `RichTextDocument` shape with a card's own
 * description, so existing comments reuse `RichTextView` unchanged. Posting
 * one uses `plainParagraph` (`@taskflow/api/richtext`, already a real
 * dependency for the renderer) rather than a native rich text EDITOR that
 * does not exist yet — the exact same boundary `card/[cardId].tsx`'s own
 * `TitleField` already draws for the description field, applied here to
 * comments instead: a plain-text composer wraps its input in the one
 * document shape a stored TEXT field may become, the same helper
 * `automation`'s rule-body and the CSV importer both reuse rather than each
 * inventing their own paragraph-wrapping.
 *
 * A deleted comment (`deletedAt !== null`) is tombstoned server-side —
 * `body`/`bodyText` come back empty, not omitted, so the thread's shape
 * survives — rendered here as a plain "Comment deleted" placeholder rather
 * than an empty `RichTextView` (which would render nothing and look like a
 * blank comment, not a deleted one).
 */
function CommentsSection({ cardId }: { readonly cardId: CardId }) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const [draft, setDraft] = useState('');

  const comments = useQuery({
    queryKey: commentsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.comments.list.query({ cardId })),
  });

  const post = useMutation({
    mutationFn: (body: string) =>
      apiClient.work.comments.create.mutate({ cardId, body: plainParagraph(body) }),
    onSuccess: async () => {
      setDraft('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: commentsQueryKey(cardId) }),
        queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
      ]);
    },
  });

  return (
    <View style={styles.commentsSection}>
      <Text style={styles.sectionHeading}>Comments</Text>

      {comments.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {comments.data?.map((comment) => (
        <CommentRow
          key={comment.commentId}
          comment={comment}
          isOwn={comment.authorId === userId}
          personOf={personOf}
        />
      ))}
      {comments.data?.length === 0 && <Text style={styles.label}>No comments yet.</Text>}

      <View style={styles.composerRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a comment…"
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
        />
        <Pressable
          style={styles.sendButton}
          disabled={draft.trim().length === 0 || post.isPending}
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
      {post.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(post.error)?.error.message ?? 'The comment was not posted.'}
        </Text>
      )}
    </View>
  );
}

function CommentRow({
  comment,
  isOwn,
  personOf,
}: {
  readonly comment: Comment;
  readonly isOwn: boolean;
  readonly personOf: (userId: string) => { readonly label: string };
}) {
  const author = isOwn
    ? 'You'
    : comment.authorId === null
      ? 'Unknown'
      : personOf(comment.authorId).label;

  return (
    <View style={styles.commentRow}>
      <View style={styles.commentMeta}>
        <Text style={styles.commentAuthor}>{author}</Text>
        <Text style={styles.commentTime}>
          {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
        </Text>
      </View>
      {comment.deletedAt !== null ? (
        <Text style={styles.commentDeleted}>Comment deleted</Text>
      ) : (
        <RichTextView document={comment.body} />
      )}
    </View>
  );
}

/**
 * Mirrors web's `TitleAndDescription` (minus the description half — no
 * native rich text EDITOR exists yet, only `rich-text-view.tsx`'s read-only
 * renderer, so a description here would need somewhere to write back to
 * that does not exist): local state seeded once from the card, an explicit
 * "Save" rather than save-on-blur, disabled until the trimmed value
 * actually differs and is non-empty. `key={cardId}` on the caller's side is
 * what makes "seeded once" true if this screen is ever reached card-to-card
 * without an unmount between — today every visit comes fresh from "My
 * Tasks", so the key is a guard against a future navigation path, not a
 * fix for an observed bug.
 */
function TitleField({
  card,
  onSave,
}: {
  readonly card: CardDetail;
  readonly onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(card.title);
  const dirty = title.trim() !== card.title && title.trim().length > 0;

  return (
    <View style={styles.titleRow}>
      <TextInput value={title} onChangeText={setTitle} style={styles.titleInput} multiline />
      {dirty && (
        <Pressable
          style={styles.saveButton}
          onPress={() => {
            onSave(title.trim());
          }}
        >
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Which status a card carries — `apps/web`'s `StatusSection`, as a chip row
 * matching `PrioritySelector`'s own shape rather than web's `<select>` (this
 * app has no native picker component, the same call `SprintSelector` below
 * already makes). `work.statuses.list` is PROJECT-scoped vocabulary, the
 * same tier labels live at — a status set is shared by every board in the
 * project, not owned by this one card. `cards.setStatus` is a DEDICATED
 * route, not part of `cards.update`'s full replace, matching web's own
 * split in `card.service.ts`: status changes emit `card.status_changed`,
 * priority rides `cards.update` alongside title and dates.
 */
function StatusSelector({
  cardId,
  projectId,
  statusId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
  readonly statusId: string | null;
}) {
  const queryClient = useQueryClient();
  const statuses = useQuery({
    queryKey: statusesQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.statuses.list.query({ projectId })),
  });

  const setStatus = useMutation({
    mutationFn: (next: string | null) =>
      apiClient.work.cards.setStatus.mutate({ cardId, statusId: next }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) });
    },
  });

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Status</Text>
      <View style={styles.priorityRow}>
        <Pressable
          style={[styles.priorityChip, statusId === null && styles.priorityChipActive]}
          disabled={setStatus.isPending}
          onPress={() => {
            if (statusId !== null) setStatus.mutate(null);
          }}
        >
          <Text style={styles.priorityChipText}>No status</Text>
        </Pressable>
        {(statuses.data ?? []).map((status) => (
          <Pressable
            key={status.statusId}
            style={[styles.priorityChip, statusId === status.statusId && styles.priorityChipActive]}
            disabled={setStatus.isPending}
            onPress={() => {
              if (statusId !== status.statusId) setStatus.mutate(status.statusId);
            }}
          >
            <View style={[styles.swatch, { backgroundColor: status.color }]} />
            <Text style={styles.priorityChipText}>{status.name}</Text>
          </Pressable>
        ))}
      </View>
      {setStatus.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(setStatus.error)?.error.message ?? 'The status was not saved.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Mirrors web's `PrioritySection`: a discrete choice fires immediately,
 * with no separate "Save" — unlike the title, tapping a chip already IS a
 * complete edit. Five options, not four: "None" clears the field, the same
 * choice web's `<select>` offers as its first `<option>`.
 */
function PrioritySelector({
  value,
  onChange,
}: {
  readonly value: Priority | null;
  readonly onChange: (priority: Priority | null) => void;
}) {
  return (
    <View style={styles.priorityRow}>
      <Pressable
        style={[styles.priorityChip, value === null && styles.priorityChipActive]}
        onPress={() => {
          onChange(null);
        }}
      >
        <Text style={styles.priorityChipText}>None</Text>
      </Pressable>
      {PRIORITIES.map((priority) => (
        <Pressable
          key={priority}
          style={[styles.priorityChip, value === priority && styles.priorityChipActive]}
          onPress={() => {
            onChange(priority);
          }}
        >
          <View style={[styles.swatch, { backgroundColor: PRIORITY_COLOR[priority] }]} />
          <Text style={styles.priorityChipText}>{PRIORITY_LABEL[priority]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Which sprint a card is in — `apps/web`'s `SprintSection`, as a chip row
 * matching `PrioritySelector`'s own shape rather than web's `<select>`
 * (this app has no native picker component). `assignSprint`/`releaseSprint`
 * are dedicated `card:update` routes, not part of `cards.update`'s full
 * replace (`use-update-card.ts`'s own header explains why sprint is not in
 * `CardPatch`), so this calls them directly rather than going through
 * `useUpdateCard`.
 *
 * A CLOSED sprint (`completed`/`cancelled`) still renders when the card is
 * currently in one — a card shows where it shipped — but only as the
 * current selection, never offered as a destination: `isOpenSprint` is the
 * same closed-list check `sprints/[projectId].tsx`'s own Move sheet uses,
 * kept here rather than trusting the server to refuse a bad tap silently.
 */
function SprintSelector({
  cardId,
  projectId,
  sprintId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
  readonly sprintId: string | null;
}) {
  const queryClient = useQueryClient();

  const sprints = useQuery({
    queryKey: sprintsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.sprints.list.query({ projectId })),
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
      queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: sprintsQueryKey(projectId) }),
    ]);
  };

  const assign = useMutation({
    mutationFn: (targetSprintId: string) =>
      apiClient.work.cards.assignSprint.mutate({ cardId, sprintId: targetSprintId }),
    onSuccess: refresh,
  });
  const release = useMutation({
    mutationFn: () => apiClient.work.cards.releaseSprint.mutate({ cardId }),
    onSuccess: refresh,
  });

  const openSprints = (sprints.data ?? []).filter(isOpenSprint);
  const closedCurrent =
    sprintId !== null && !openSprints.some((sprint) => sprint.sprintId === sprintId)
      ? sprints.data?.find((sprint) => sprint.sprintId === sprintId)
      : undefined;

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Sprint</Text>
      <View style={styles.priorityRow}>
        <Pressable
          style={[styles.priorityChip, sprintId === null && styles.priorityChipActive]}
          disabled={release.isPending}
          onPress={() => {
            if (sprintId !== null) release.mutate();
          }}
        >
          <Text style={styles.priorityChipText}>Backlog</Text>
        </Pressable>
        {openSprints.map((sprint) => (
          <Pressable
            key={sprint.sprintId}
            style={[styles.priorityChip, sprintId === sprint.sprintId && styles.priorityChipActive]}
            disabled={assign.isPending}
            onPress={() => {
              if (sprintId !== sprint.sprintId) assign.mutate(sprint.sprintId);
            }}
          >
            <Text style={styles.priorityChipText}>{sprint.name}</Text>
          </Pressable>
        ))}
        {closedCurrent !== undefined && (
          <View
            style={[styles.priorityChip, styles.priorityChipActive, styles.priorityChipDisabled]}
          >
            <Text style={styles.priorityChipText}>{closedCurrent.name}</Text>
          </View>
        )}
      </View>
      {(assign.isError || release.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(assign.error ?? release.error)?.error.message ?? 'The sprint was not saved.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Who a card is assigned to — `apps/web`'s `AssigneeSection`. Sends the
 * WHOLE SET rather than an add/remove delta, matching `cards.assign` on
 * the server: two people editing assignees concurrently with deltas
 * converge on a set neither of them chose, whereas the intended set means
 * the last writer wins something a human actually asked for.
 *
 * **A modal picker, not a wall of chips** — the same call web's own header
 * makes and for the identical reason: an org's member list can run to
 * dozens of people, and scrolling past fifty names inline to find one
 * checkbox is the bug this avoids. Every tap inside the picker sends the
 * full set immediately (not disabled while pending) — assigning two or
 * three people in a row is the normal gesture, and a control that goes
 * dead between each tap turns one action into three waits.
 */
function AssigneeSelector({
  cardId,
  assigneeIds,
}: {
  readonly cardId: CardId;
  readonly assigneeIds: readonly string[];
}) {
  const queryClient = useQueryClient();
  const { people, peopleOf } = useMembers();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const assign = useMutation({
    mutationFn: (ids: readonly string[]) =>
      apiClient.work.cards.assign.mutate({ cardId, assigneeIds: [...ids] }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: cardQueryKey(cardId) }),
        // Assigning/unassigning changes whether this card appears in "My
        // Tasks" at all — unlike status/labels, which that screen does not
        // show or filter by.
        queryClient.invalidateQueries({ queryKey: MY_TASKS_QUERY_KEY }),
      ]);
    },
  });

  const selected = new Set(assigneeIds);
  const assigned = peopleOf(assigneeIds);

  const toggle = (userId: string) => {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    assign.mutate([...next]);
  };

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ''
      ? people
      : people.filter((member: Member) => member.email.toLowerCase().includes(needle));

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Assignees</Text>
      <View style={styles.assigneeRow}>
        {assigned.length === 0 && <Text style={styles.emptyHint}>Unassigned</Text>}
        {assigned.map((person) => (
          <Pressable
            key={person.userId}
            style={styles.assigneeChip}
            onPress={() => {
              toggle(person.userId);
            }}
          >
            <Avatar label={person.label} size={20} />
            <Text style={styles.assigneeChipText} numberOfLines={1}>
              {person.label}
            </Text>
          </Pressable>
        ))}
        <Pressable
          style={styles.addChipButton}
          onPress={() => {
            setQuery('');
            setPickerOpen(true);
          }}
        >
          <Text style={styles.addChipButtonText}>+</Text>
        </Pressable>
      </View>
      {assign.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(assign.error)?.error.message ?? 'Assignees were not saved.'}
        </Text>
      )}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Assign to…</Text>
            {people.length > 8 && (
              <TextInput
                style={styles.modalInput}
                placeholder="Search members…"
                placeholderTextColor={colors.inkFaint.hex}
                value={query}
                onChangeText={setQuery}
              />
            )}
            <ScrollView style={styles.pickerList}>
              {filtered.length === 0 ? (
                <Text style={styles.emptyHint}>No matches.</Text>
              ) : (
                filtered.map((member: Member) => {
                  const on = selected.has(member.userId);
                  return (
                    <Pressable
                      key={member.userId}
                      style={styles.pickerRow}
                      onPress={() => {
                        toggle(member.userId);
                      }}
                    >
                      <Avatar label={member.displayName ?? member.email} size={24} />
                      <Text style={styles.pickerRowText} numberOfLines={1}>
                        {member.displayName ?? member.email}
                      </Text>
                      {on && <Text style={styles.pickerCheck}>✓</Text>}
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * Labels on a card, and the project's label set — `apps/web`'s
 * `LabelSection`, as an inline chip row (not the assignee picker's modal):
 * a project's label set is typically five to eight entries, the same
 * distinction web's own header draws between "tolerable as a wall of
 * chips" and "not" at member-list scale.
 *
 * Two authorization questions, deliberately not merged
 * (`apps/api/src/work/label.service.ts`): TAGGING a card is `card:update`
 * — it changes one card; MANAGING the label set is `project:update` — it
 * changes every card in the project. The UI shows both controls to
 * everyone and lets the server answer, never a client-side role check
 * (CLAUDE.md §8.2).
 */
function LabelSelector({
  cardId,
  projectId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState('');

  const all = useQuery({
    queryKey: labelsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.labels.list.query({ projectId })),
  });
  const onCard = useQuery({
    queryKey: cardLabelsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.labels.onCard.query({ cardId })),
  });

  const selected = new Set((onCard.data ?? []).map((label) => label.labelId));

  const setLabels = useMutation({
    mutationFn: (labelIds: readonly string[]) =>
      apiClient.work.labels.setOnCard.mutate({ cardId, labelIds: [...labelIds] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardLabelsQueryKey(cardId) });
    },
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      apiClient.work.labels.create.mutate({
        projectId,
        name,
        color: nextLabelColor(all.data?.length ?? 0),
      }),
    onSuccess: () => {
      setCreating('');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: labelsQueryKey(projectId) });
    },
  });

  const toggle = (labelId: string) => {
    const next = new Set(selected);
    if (next.has(labelId)) next.delete(labelId);
    else next.add(labelId);
    setLabels.mutate([...next]);
  };

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Labels</Text>

      {all.data?.length === 0 ? (
        <Text style={styles.emptyHint}>This project has no labels yet.</Text>
      ) : (
        <View style={styles.assigneeRow}>
          {(all.data ?? []).map((label) => {
            const on = selected.has(label.labelId);
            return (
              <Pressable
                key={label.labelId}
                style={[
                  styles.labelChip,
                  on ? { backgroundColor: label.color } : styles.labelChipOff,
                ]}
                onPress={() => {
                  toggle(label.labelId);
                }}
              >
                <Text style={[styles.labelChipText, on && styles.labelChipTextOn]}>
                  {label.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={styles.addCardRow}>
        <TextInput
          style={styles.addCardInput}
          placeholder="New label"
          placeholderTextColor={colors.inkFaint.hex}
          value={creating}
          onChangeText={setCreating}
          onSubmitEditing={() => {
            const value = creating.trim();
            if (value !== '') create.mutate(value);
          }}
        />
        <Pressable
          style={styles.addCardButton}
          disabled={create.isPending || creating.trim().length === 0}
          onPress={() => {
            const value = creating.trim();
            if (value !== '') create.mutate(value);
          }}
        >
          <Text style={styles.addCardButtonText}>Add</Text>
        </Pressable>
      </View>
      {(setLabels.isError || create.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(setLabels.error ?? create.error)?.error.message ?? 'Labels were not saved.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Custom field values on a card — `apps/web`'s `CustomFieldSection`, the
 * last card-detail vocabulary section this pass closes (following status,
 * assignees and labels). The DEFINITIONS are project vocabulary
 * (`project:update`); filling one in is `card:update` — the same split
 * `LabelSelector` above already draws, and both controls render for
 * everyone with the server as the only adjudicator (CLAUDE.md §8.2).
 *
 * **Field TYPES are immutable on the server, deliberately** — there is no
 * honest migration from `select` to `number`; every stored value would
 * have to become something, and drop/coerce/keep all silently rewrite
 * data a person entered. `AddFieldForm` below only ever CREATES, never
 * edits a type.
 *
 * **`value` is `unknown` at the boundary on both ends, matching the
 * server exactly** — `setOnCard` takes `z.unknown()` because the legal
 * shape depends on the field's declared TYPE, which only the database
 * knows; a Zod union here would have to guess before knowing. `FieldInput`
 * below sends the natural JS value for each control and lets the service
 * refuse a mismatch rather than pre-empting it.
 */
function CustomFieldSection({
  cardId,
  projectId,
}: {
  readonly cardId: CardId;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();

  const definitions = useQuery({
    queryKey: fieldsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.fields.list.query({ projectId })),
  });
  const values = useQuery({
    queryKey: cardFieldsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.fields.onCard.query({ cardId })),
  });

  const set = useMutation({
    mutationFn: (input: { fieldId: string; value: unknown }) =>
      apiClient.work.fields.setOnCard.mutate({ cardId, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: cardFieldsQueryKey(cardId) });
    },
  });

  const live = (definitions.data ?? []).filter((field) => field.archivedAt === null);
  const byField = new Map((values.data ?? []).map((entry) => [entry.fieldId, entry.value]));

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Fields</Text>

      {live.length === 0 && (
        <Text style={styles.emptyHint}>
          This project has no custom fields yet. Adding one here defines it for every card in the
          project.
        </Text>
      )}

      {live.map((field) => (
        <View key={field.fieldId} style={styles.fieldRow}>
          <Text style={styles.fieldName} numberOfLines={1}>
            {field.name}
          </Text>
          <View style={styles.fieldInputWrap}>
            <FieldInput
              type={field.type}
              options={field.options}
              value={byField.get(field.fieldId) ?? null}
              onCommit={(value) => {
                set.mutate({ fieldId: field.fieldId, value });
              }}
            />
          </View>
        </View>
      ))}

      <AddFieldForm projectId={projectId} />

      {set.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(set.error)?.error.message ?? 'The field was not saved.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Defining a new custom field — `project:update`, changing every card in
 * the project, the same "vocabulary vs. one card" split this file's
 * header already names. The TYPE picker is a chip row, not web's
 * `<select>`, matching every other enum control on this screen.
 */
function AddFieldForm({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');

  const needsOptions = type === 'select' || type === 'multi_select';

  const create = useMutation({
    mutationFn: () =>
      apiClient.work.fields.create.mutate({
        projectId,
        name: name.trim(),
        type,
        options: needsOptions
          ? options
              .split(',')
              .map((option) => option.trim())
              .filter((option) => option !== '')
          : null,
      }),
    onSuccess: async () => {
      setName('');
      setOptions('');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: fieldsQueryKey(projectId) });
    },
  });

  if (!open) {
    return (
      <Pressable
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.checklistAddItemText}>+ Add field</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.addFieldForm}>
      <TextInput
        style={styles.modalInput}
        placeholder="Field name"
        placeholderTextColor={colors.inkFaint.hex}
        value={name}
        onChangeText={setName}
      />
      <View style={styles.priorityRow}>
        {CUSTOM_FIELD_TYPES.map((entry) => (
          <Pressable
            key={entry}
            style={[styles.priorityChip, type === entry && styles.priorityChipActive]}
            onPress={() => {
              setType(entry);
            }}
          >
            <Text style={styles.priorityChipText}>{entry}</Text>
          </Pressable>
        ))}
      </View>
      {needsOptions && (
        <TextInput
          style={styles.modalInput}
          placeholder="Low, Medium, High"
          placeholderTextColor={colors.inkFaint.hex}
          value={options}
          onChangeText={setOptions}
        />
      )}
      <View style={styles.modalActions}>
        <Pressable
          style={styles.modalPrimaryButton}
          disabled={create.isPending || name.trim().length === 0}
          onPress={() => {
            create.mutate();
          }}
        >
          <Text style={styles.modalPrimaryButtonText}>Add</Text>
        </Pressable>
        <Pressable
          style={styles.modalSecondaryButton}
          onPress={() => {
            setOpen(false);
          }}
        >
          <Text style={styles.modalSecondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
      {create.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(create.error)?.error.message ?? 'The field was not created.'}
        </Text>
      )}
    </View>
  );
}

/**
 * The control for one field type. `type: 'user'` falls through to the
 * plain-text default, matching `apps/web`'s own `FieldInput` exactly —
 * web has no specialized picker for it either (a real gap in its own
 * implementation, per that file's own field-type list), and this mirrors
 * web's ACTUAL behavior rather than quietly building a nicer one that
 * would leave the two platforms disagreeing on what a `user` field looks
 * like. `date` is a plain `YYYY-MM-DD` text entry rather than a native
 * calendar picker — the same "no date-picker dependency added yet" stance
 * this app already takes for a card's own due/start dates.
 */
function FieldInput({
  type,
  options,
  value,
  onCommit,
}: {
  readonly type: string;
  readonly options: unknown;
  readonly value: unknown;
  readonly onCommit: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(() => textValueOf(type, value));

  if (type === 'checkbox') {
    return (
      <Pressable
        style={[styles.checklistBox, value === true && styles.checklistBoxDone]}
        onPress={() => {
          onCommit(value !== true);
        }}
      >
        {value === true && <Text style={styles.checklistBoxCheck}>✓</Text>}
      </Pressable>
    );
  }

  if (type === 'select') {
    const choices = Array.isArray(options) ? options.filter(isChoiceString) : [];
    return (
      <View style={styles.priorityRow}>
        {choices.map((choice) => {
          const on = value === choice;
          return (
            <Pressable
              key={choice}
              style={[styles.priorityChip, on && styles.priorityChipActive]}
              onPress={() => {
                onCommit(on ? null : choice);
              }}
            >
              <Text style={styles.priorityChipText}>{choice}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  if (type === 'multi_select') {
    // An ARRAY, not a string — `validateFieldValue` rejects a bare string
    // for this type, and deduplicates what it receives.
    const choices = Array.isArray(options) ? options.filter(isChoiceString) : [];
    const selected = Array.isArray(value) ? value.filter(isChoiceString) : [];
    return (
      <View style={styles.priorityRow}>
        {choices.map((choice) => {
          const on = selected.includes(choice);
          return (
            <Pressable
              key={choice}
              style={[styles.priorityChip, on && styles.priorityChipActive]}
              onPress={() => {
                onCommit(on ? selected.filter((entry) => entry !== choice) : [...selected, choice]);
              }}
            >
              <Text style={styles.priorityChipText}>{choice}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  // text, number, date, and user (see this function's own header) all
  // commit on blur, not on every keystroke — each commit is a mutation
  // that emits a domain event and an audit entry, so one per character
  // would make the audit log unreadable.
  return (
    <TextInput
      style={styles.addCardInput}
      value={draft}
      placeholder={type === 'date' ? 'YYYY-MM-DD' : undefined}
      placeholderTextColor={colors.inkFaint.hex}
      keyboardType={type === 'number' ? 'numeric' : 'default'}
      onChangeText={setDraft}
      onEndEditing={() => {
        commitTextValue(type, draft, onCommit);
      }}
    />
  );
}

function isChoiceString(value: unknown): value is string {
  return typeof value === 'string';
}

function textValueOf(type: string, value: unknown): string {
  if (type === 'number') return typeof value === 'number' ? String(value) : '';
  if (type === 'date') return typeof value === 'string' ? value.slice(0, 10) : '';
  return typeof value === 'string' ? value : '';
}

function commitTextValue(type: string, raw: string, onCommit: (value: unknown) => void): void {
  const trimmed = raw.trim();

  if (type === 'number') {
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) onCommit(parsed);
    return;
  }

  if (type === 'date') {
    onCommit(trimmed === '' ? null : new Date(`${trimmed}T00:00:00`).toISOString());
    return;
  }

  onCommit(trimmed === '' ? null : trimmed);
}

/**
 * Attachments on a card — `apps/web`'s `AttachmentSection` (⚠ human-review
 * surface, CLAUDE.md §2.2: any file upload/download path), the mobile
 * counterpart of Chat's already-shipped composer attaching
 * (`channel/[channelId].tsx`'s "Chat, complete" section). Reuses
 * `pick-attachment.ts` unchanged and `upload-card-attachment.ts` for the
 * three-step presign/PUT/confirm pipeline — see that file's own header
 * for why it is a separate module from Chat's rather than one shared
 * uploader.
 *
 * **The same two rules Chat's own attach flow already lives by, restated
 * here because this is a SEPARATE human-review surface from that one:**
 * a successful PUT is never treated as a successful upload — the object
 * exists in storage the moment the PUT finishes and nothing can prevent
 * that, so only `confirm`'s verdict (magic bytes checked, scanned)
 * decides whether anyone is ever handed a download URL. And a download is
 * only ever offered for `status === 'clean'` — `presignDownload` refuses
 * every other status with a 404, so offering the control on a `pending`
 * row is a button that cannot work, and on an `infected` row one that
 * must not.
 *
 * Unlike Chat's version there is no "send a message first" step — a
 * card, unlike a chat message, already exists by the time this screen can
 * render at all, so `presign` goes straight to `cardId`.
 */
function AttachmentSection({ cardId }: { readonly cardId: CardId }) {
  const queryClient = useQueryClient();
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{
    readonly kind: 'success' | 'failure';
    readonly text: string;
  } | null>(null);

  const attachments = useQuery({
    queryKey: attachmentsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.attachments.list.query({ cardId })),
  });

  const upload = useMutation({
    mutationFn: (file: Awaited<ReturnType<typeof pickAttachment>>) => {
      if (file === null) return Promise.resolve(null);
      setUploadNotice(null);
      return uploadCardAttachment(
        {
          presign: (input) => apiClient.work.attachments.presign.mutate(input),
          confirm: (input) => apiClient.work.attachments.confirm.mutate(input),
        },
        cardId,
        file,
        setUploadStage,
      );
    },
    onSuccess: (result) => {
      if (result === null) return;
      if (result.status === 'clean') {
        setUploadNotice({ kind: 'success', text: 'File uploaded.' });
      } else {
        setUploadNotice({
          kind: 'failure',
          text:
            result.status === 'infected'
              ? 'That file was rejected: malware detected.'
              : `That file was rejected: ${result.reason ?? 'it did not pass verification.'}`,
        });
      }
    },
    onError: () => {
      setUploadNotice({ kind: 'failure', text: 'The file was not uploaded.' });
    },
    onSettled: async () => {
      setUploadStage(null);
      await queryClient.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
    },
  });

  const download = useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.work.attachments.download.mutate({ attachmentId }),
    onSuccess: (result) => {
      void Linking.openURL(result.url);
    },
  });

  const remove = useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.work.attachments.delete.mutate({ attachmentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
    },
  });

  return (
    <View style={styles.sprintSection}>
      <Text style={styles.sprintSectionLabel}>Attachments</Text>

      {(attachments.data ?? []).map((attachment) => {
        const downloadable = attachment.status === 'clean';
        return (
          <View key={attachment.attachmentId} style={styles.attachmentRow}>
            <View style={styles.attachmentInfo}>
              <Text style={styles.attachmentName} numberOfLines={1}>
                {attachment.filename}
              </Text>
              <Text
                style={[
                  styles.attachmentStatus,
                  attachment.status === 'infected' && styles.attachmentStatusDanger,
                  attachment.status === 'rejected' && styles.attachmentStatusWarning,
                ]}
              >
                {attachment.sizeBytes !== null && `${formatBytes(attachment.sizeBytes)} · `}
                {ATTACHMENT_STATUS_TEXT.get(attachment.status) ?? attachment.status}
              </Text>
            </View>
            {downloadable && (
              <Pressable
                disabled={download.isPending}
                onPress={() => {
                  download.mutate(attachment.attachmentId);
                }}
              >
                <Text style={styles.checklistDeleteText}>Download</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                remove.mutate(attachment.attachmentId);
              }}
            >
              <Text style={styles.checklistDeleteText}>Remove</Text>
            </Pressable>
          </View>
        );
      })}

      <Pressable
        disabled={upload.isPending}
        onPress={() => {
          void pickAttachment().then((file) => {
            upload.mutate(file);
          });
        }}
      >
        <Text style={styles.checklistAddItemText}>+ Attach a file</Text>
      </Pressable>

      {uploadStage !== null && <Text style={styles.emptyHint}>{uploadStage}</Text>}
      {uploadNotice !== null && (
        <Text
          style={uploadNotice.kind === 'failure' ? styles.error : styles.emptyHint}
          accessibilityRole={uploadNotice.kind === 'failure' ? 'alert' : undefined}
        >
          {uploadNotice.text}
        </Text>
      )}
      {(download.isError || remove.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(download.error ?? remove.error)?.error.message ??
            'That action could not be completed.'}
        </Text>
      )}
    </View>
  );
}

/**
 * The status column's state machine, as wording — ported verbatim from
 * `apps/web`'s own `STATUS_TEXT`. A `Map`, not a `Record`: the key comes
 * from the server as a plain string, and a `Record` lookup would TYPE as
 * `string` while being `undefined` at runtime for a status this build has
 * not heard of. `.get()` says so, and the fallback shows the raw value
 * instead of a blank line.
 */
const ATTACHMENT_STATUS_TEXT: ReadonlyMap<string, string> = new Map([
  ['pending', 'Waiting for the upload to finish'],
  ['scanning', 'Scanning'],
  ['clean', 'Ready'],
  ['infected', 'Malware detected — this file cannot be downloaded'],
  ['rejected', 'Refused: the contents did not match the declared type, or it could not be scanned'],
]);

function BackButton() {
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

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  commentsSection: {
    marginTop: 16,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line.hex,
    paddingTop: 16,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  commentRow: {
    gap: 4,
  },
  commentMeta: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'baseline',
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  commentTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  commentDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  composerRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    marginTop: 4,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  reference: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
  },
  titleRow: {
    gap: 8,
  },
  titleInput: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.ink.hex,
    padding: 0,
  },
  saveButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  priorityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  priorityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  priorityChipActive: {
    borderColor: colors.accent.hex,
    backgroundColor: colors.surfaceHover.hex,
  },
  priorityChipText: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  priorityChipDisabled: {
    opacity: 0.6,
  },
  sprintSection: {
    gap: 6,
  },
  sprintSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.surfaceHover.hex,
  },
  badgeOverdue: {
    backgroundColor: colors.danger.hex + '33',
  },
  swatch: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  badgeOverdueText: {
    color: colors.danger.hex,
  },
  badgeDoneText: {
    color: colors.success.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  checklistGroup: {
    gap: 4,
    marginBottom: 8,
  },
  checklistHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checklistName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  checklistCount: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  checklistDeleteButton: {
    marginLeft: 'auto',
  },
  checklistDeleteText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  checklistItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
    paddingVertical: 2,
  },
  checklistBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line.hex,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken.hex,
  },
  checklistBoxDone: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  checklistBoxCheck: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentInk.hex,
  },
  checklistItemText: {
    flex: 1,
    fontSize: 13,
    color: colors.ink.hex,
  },
  checklistItemTextDone: {
    color: colors.inkFaint.hex,
    textDecorationLine: 'line-through',
  },
  checklistItemRemove: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingHorizontal: 4,
  },
  checklistAddItemText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
    paddingLeft: 4,
    paddingVertical: 4,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  attachmentInfo: {
    flex: 1,
    gap: 2,
  },
  attachmentName: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  attachmentStatus: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  attachmentStatusDanger: {
    color: colors.danger.hex,
  },
  attachmentStatusWarning: {
    color: colors.warning.hex,
  },
  assigneeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  assigneeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: colors.surfaceHover.hex,
  },
  assigneeChipText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    maxWidth: 120,
  },
  addChipButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  addChipButtonText: {
    fontSize: 14,
    color: colors.inkMuted.hex,
  },
  labelChip: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  labelChipOff: {
    backgroundColor: colors.surfaceHover.hex,
  },
  labelChipText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  labelChipTextOn: {
    color: '#ffffff',
    fontWeight: '600',
  },
  addCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addCardInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  addCardButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addCardButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
    gap: 4,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    marginBottom: 8,
  },
  pickerList: {
    marginBottom: 8,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  pickerRowText: {
    flex: 1,
    fontSize: 14,
    color: colors.ink.hex,
  },
  pickerCheck: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSecondaryButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  fieldRow: {
    gap: 4,
    marginBottom: 8,
  },
  fieldName: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  fieldInputWrap: {
    minHeight: 28,
    justifyContent: 'center',
  },
  addFieldForm: {
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    padding: 10,
  },
});
