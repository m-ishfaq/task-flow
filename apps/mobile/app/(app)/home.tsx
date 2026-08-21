import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import {
  loadPasskeys,
  toRegistrationResponse,
  type PasskeyCreationResult,
} from '../../src/lib/passkeys.js';
import {
  PRIORITY_COLOR,
  PRIORITY_LABEL,
  formatDueDate,
  type CardSummary,
} from '../../src/lib/work.js';

/**
 * "My Tasks" (ai/phase-14-mobile.md Wave 2 roadmap row: "Work — boards,
 * lists, cards, My Tasks, card detail...") — Wave 2's first slice and the
 * first real product screen on native, replacing Wave 1's placeholder.
 *
 * Deliberately the SMALLEST useful cut of Work, mirroring
 * `apps/web/src/features/work/home-page.tsx` + `list-view.tsx`, not the
 * board/kanban view: a flat, read-only list of the caller's own cards
 * across every board they can reach (`work.cards.mine`), no drag-and-drop,
 * no TipTap rendering (§6.4 is real work, and this screen never shows a
 * card's description), no optimistic mutations, and no card-detail
 * navigation — tapping a card is a Wave 2 follow-up, not this slice.
 * `list-view.tsx`'s own header comment already makes the same "no
 * drag-and-drop, no inline create" call for the identical reason on web:
 * this is a reshaping of cards that live elsewhere, not a place new ones
 * are written.
 *
 * Status is deliberately NOT shown, matching `home-page.tsx` exactly — see
 * that investigation's own finding: status definitions are per-PROJECT
 * (Phase 3.5), "My Tasks" spans many projects at once, and nothing in this
 * codebase has ever needed to batch-resolve status names/colors across
 * projects for one screen. Priority has no such problem — it is a fixed
 * four-value enum, not project-scoped data — so it renders here for free.
 *
 * The "Add a passkey" action and sign-out both move to a slim footer below
 * the list, which is now the primary content — they were the whole screen
 * in Wave 1's placeholder and are secondary now.
 */
export default function Home() {
  const [passkeySupported, setPasskeySupported] = useState(false);

  /* See sign-in.tsx's identical effect for why this is state resolved after
     mount rather than a synchronous `isSupported()` call: the module is now
     loaded lazily (passkeys.ts's header), so a static top-level import can
     no longer answer this question before render. */
  useEffect(() => {
    let cancelled = false;
    loadPasskeys()
      .then((mod) => {
        if (!cancelled) setPasskeySupported(mod.isSupported());
      })
      .catch(() => {
        if (!cancelled) setPasskeySupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cards = useQuery({
    queryKey: ['work.cards.mine'],
    queryFn: async () => wire(await apiClient.work.cards.mine.query({ includeArchived: false })),
  });

  const addPasskey = useMutation({
    mutationFn: async () => {
      const options = await apiClient.auth.passkeys.startRegistration.mutate();
      const { create } = await loadPasskeys();
      const result = await create(options as never);
      if (result === null) return null;
      // See sign-in.tsx's identical cast for why: the library's own
      // CreationResponse type and this function's precise, hand-written
      // PasskeyCreationResult describe the same wire shape under two
      // different TypeScript declarations.
      const response = toRegistrationResponse(result as unknown as PasskeyCreationResult);
      return apiClient.auth.passkeys.finishRegistration.mutate({ response: response as never });
    },
  });

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Tasks</Text>

      <FlatList<CardSummary>
        data={cards.data}
        keyExtractor={(card) => card.cardId}
        renderItem={renderCard}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          cards.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>Nothing assigned to you right now.</Text>
          )
        }
      />

      <View style={styles.footer}>
        {passkeySupported && (
          <>
            {addPasskey.isError && (
              <Text style={styles.error} accessibilityRole="alert">
                {apiErrorOf(addPasskey.error)?.error.message ?? 'Could not add a passkey.'}
              </Text>
            )}
            {addPasskey.isSuccess && addPasskey.data !== null && (
              <Text style={styles.label}>Passkey added.</Text>
            )}
            <Pressable
              style={styles.secondaryButton}
              disabled={addPasskey.isPending}
              onPress={() => {
                addPasskey.mutate();
              }}
            >
              {addPasskey.isPending ? (
                <ActivityIndicator color={colors.ink.hex} />
              ) : (
                <Text style={styles.secondaryButtonText}>Add a passkey to this device</Text>
              )}
            </Pressable>
          </>
        )}

        <Pressable
          style={styles.button}
          onPress={() => {
            void session.signOut();
          }}
        >
          <Text style={styles.buttonText}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

function renderCard({ item: card }: ListRenderItemInfo<CardSummary>) {
  const due = formatDueDate(card.dueDate);
  const checklistDone = card.checklistTotal > 0 && card.checklistDone === card.checklistTotal;

  return (
    <View style={styles.card}>
      <View style={styles.cardTopRow}>
        <Text style={styles.reference}>{card.reference}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {card.title}
        </Text>
      </View>
      <View style={styles.badgeRow}>
        {card.priority !== null && (
          <View style={styles.badge}>
            <View style={[styles.swatch, { backgroundColor: PRIORITY_COLOR[card.priority] }]} />
            <Text style={styles.badgeText}>{PRIORITY_LABEL[card.priority]}</Text>
          </View>
        )}
        {due !== null && (
          <View style={[styles.badge, due.overdue && styles.badgeOverdue]}>
            <Text style={[styles.badgeText, due.overdue && styles.badgeOverdueText]}>
              {due.label}
            </Text>
          </View>
        )}
        {card.checklistTotal > 0 && (
          <View style={styles.badge}>
            <Text style={[styles.badgeText, checklistDone && styles.badgeDoneText]}>
              {card.checklistDone}/{card.checklistTotal}
            </Text>
          </View>
        )}
        {card.commentCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>💬 {card.commentCount}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 24,
    paddingHorizontal: 24,
    gap: 12,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 8,
    paddingBottom: 8,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    gap: 8,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reference: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
  },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    color: colors.ink.hex,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
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
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: 8,
  },
  footer: {
    gap: 8,
    paddingBottom: 8,
  },
  button: {
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger.hex,
  },
  buttonText: {
    color: colors.danger.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
});
