import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { CardIdSchema } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { PRIORITY_COLOR, PRIORITY_LABEL, formatDueDate } from '../../../src/lib/work.js';

/**
 * Card detail (Wave 2's second slice, following "My Tasks" —
 * `ai/phase-14-mobile.md` roadmap row: "...card detail; the TipTap-JSON
 * native renderer (§6.4)..."). Read-only, deliberately: editing needs
 * optimistic mutations and a version-conflict story `use-update-card.ts`
 * already has on web, and is its own increment rather than folded into the
 * screen that first makes a card reachable at all.
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

function CardDetailContent({ cardId }: { cardId: ReturnType<typeof CardIdSchema.parse> }) {
  const card = useQuery({
    queryKey: ['work.cards.get', cardId],
    queryFn: async () => wire(await apiClient.work.cards.get.query({ cardId })),
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
      <Text style={styles.title}>{data.title}</Text>

      <View style={styles.badgeRow}>
        {data.priority !== null && (
          <View style={styles.badge}>
            <View style={[styles.swatch, { backgroundColor: PRIORITY_COLOR[data.priority] }]} />
            <Text style={styles.badgeText}>{PRIORITY_LABEL[data.priority]}</Text>
          </View>
        )}
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
  title: {
    fontSize: 20,
    fontWeight: '600',
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
});
