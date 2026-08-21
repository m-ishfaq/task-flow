import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { CardIdSchema, type CardId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { useUpdateCard } from '../../../src/lib/use-update-card.js';
import {
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  cardQueryKey,
  formatDueDate,
  type CardDetail,
  type Priority,
} from '../../../src/lib/work.js';

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * Card detail (Wave 2's second slice, following "My Tasks", then made
 * editable as Wave 2's "optimistic mutations" roadmap item —
 * `ai/phase-14-mobile.md`). Title and priority are editable; everything
 * else stays read-only for now — see the header on each section below for
 * exactly why.
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
 * No custom header/back chrome exists anywhere in this app yet (`app/
 * _layout.tsx` renders a bare `<Slot />`, no `Stack`) — a manual back
 * button matches every other screen's own manual `Pressable` buttons rather
 * than introducing react-navigation's header for one screen.
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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <BackButton />
      <Text style={styles.reference}>{data.reference}</Text>

      <TitleField
        key={cardId}
        card={data}
        onSave={(title) => {
          update.mutate({ title });
        }}
      />

      <PrioritySelector
        value={data.priority}
        onChange={(priority) => {
          setSaveError(null);
          update.mutate({ priority });
        }}
      />

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
    </ScrollView>
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
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingTop: 24,
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
});
