import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { CardIdSchema, type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { parseFormattedText } from '../../../src/lib/rich-text-compose.js';
import { useCardRoom } from '../../../src/lib/use-board-room.js';
import { useUpdateCard } from '../../../src/lib/use-update-card.js';
import { cardQueryKey, formatDueDate } from '../../../src/lib/work.js';
import { BackButton } from '../../../src/lib/card-detail-shared.js';
import { styles } from '../../../src/lib/card-detail-styles.js';
import { ChecklistSection } from '../../../src/lib/card-checklist-section.js';
import { CommentsSection } from '../../../src/lib/card-comments-section.js';
import { DateSection, DescriptionField, TitleField } from '../../../src/lib/card-fields.js';
import {
  AssigneeSelector,
  LabelSelector,
  PrioritySelector,
  SprintSelector,
  StatusSelector,
} from '../../../src/lib/card-selectors.js';
import { CustomFieldSection } from '../../../src/lib/card-custom-field-section.js';
import { AttachmentSection } from '../../../src/lib/card-attachment-section.js';

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
  const orgId = useSession((state) => state.orgId);
  const card = useQuery({
    queryKey: cardQueryKey(cardId),
    queryFn: async () => wire(await apiClient.work.cards.get.query({ cardId })),
  });
  // `boardId` is only known once `card.data` has loaded — `useCardRoom`
  // itself does not join until it is. See that hook's own header on why
  // this is safe now (reference-counted board rooms) where it was not
  // before: this screen can be open at the same time as `board/[boardId]
  // .tsx`, unpopped underneath it in the navigator stack.
  useCardRoom(orgId, card.data?.boardId ?? null, cardId);

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

        <DateSection
          startDate={data.startDate}
          dueDate={data.dueDate}
          onChangeStartDate={(iso) => {
            setSaveError(null);
            update.mutate({ startDate: iso });
          }}
          onChangeDueDate={(iso) => {
            setSaveError(null);
            update.mutate({ dueDate: iso });
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

        <DescriptionField
          key={`${cardId}-description`}
          description={data.description}
          onSave={(text) => {
            setSaveError(null);
            update.mutate({
              description: text.trim() === '' ? null : parseFormattedText(text.trim()),
            });
          }}
        />

        <ChecklistSection cardId={cardId} boardId={data.boardId} />

        <AttachmentSection cardId={cardId} />

        <CommentsSection cardId={cardId} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
