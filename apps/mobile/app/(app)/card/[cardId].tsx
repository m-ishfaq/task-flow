import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
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
import {
  MY_TASKS_QUERY_KEY,
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  cardLabelsQueryKey,
  cardQueryKey,
  commentsQueryKey,
  formatDueDate,
  labelsQueryKey,
  nextLabelColor,
  statusesQueryKey,
  type CardDetail,
  type Comment,
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

        <CommentsSection cardId={cardId} />
      </ScrollView>
    </KeyboardAvoidingView>
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
});
