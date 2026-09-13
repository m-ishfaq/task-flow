import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { useMembers } from './use-members.js';
import {
  NOTIFICATIONS_QUERY_KEY,
  NOTIFICATION_COUNT_QUERY_KEY,
  mobileRouteFor,
  notificationIcon,
  type NotificationSummary,
} from './notifications.js';

/**
 * The bell — mentions, direct messages, thread replies, card assignments,
 * missed calls, ORG-WIDE and across every product surface. Ported from
 * `apps/web/src/features/chat/notification-bell.tsx`.
 *
 * ## Reachable from every screen, not just Chat
 *
 * `notifications.ts`'s own header used to name this as "the one real,
 * stated divergence from web": web mounts its bell once in `shell.tsx`,
 * visible on every route, while this app had "no single shared chrome to
 * mount an equivalent in without touching all four tab screens" — true when
 * written, and now stale, corrected in place per this repo's own habit
 * rather than silently rewritten: `call-surface.tsx` proved that chrome
 * exists, and `top-bar.tsx` is now the thing that mounts this, once, above
 * the `<Stack>` — the same reason a ringing call is answerable from
 * anywhere.
 *
 * ## No longer owns its own screen position
 *
 * This used to be the one thing anchored at the safe-area edge, with its
 * own `position: 'absolute'`. `top-bar.tsx`'s own header explains why that
 * moved up a level once a second icon (Account) needed to sit beside it:
 * two independently-positioned overlays is how two icons quietly drift out
 * of alignment; one row owning the one position is how they can't. The
 * `trigger` style below is now just a 36×36 button sized to sit inside
 * that row — same visual button as before, no longer floating on its own.
 */
export function NotificationBell(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { personOf } = useMembers();

  const notificationCount = useQuery({
    queryKey: NOTIFICATION_COUNT_QUERY_KEY,
    queryFn: () => apiClient.notifications.unreadCount.query(),
    refetchInterval: 20_000,
  });
  const notifications = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.notifications.listMine.query()),
    refetchInterval: 20_000,
    enabled: open,
  });

  const unread = notificationCount.data?.unread ?? 0;

  return (
    <>
      <Pressable
        style={styles.trigger}
        accessibilityLabel={
          unread > 0 ? `Notifications, ${String(unread)} unread` : 'Notifications'
        }
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.triggerText}>🔔</Text>
        {unread > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread > 9 ? '9+' : String(unread)}</Text>
          </View>
        )}
      </Pressable>

      <NotificationsModal
        open={open}
        rows={notifications.data ?? []}
        personOf={personOf}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

/**
 * Tapping a row marks only THAT row read and opens it; "Mark all read" is
 * the separate bulk action — the same split web draws and for the identical
 * reason: reading one mention should not silently mark forty others read
 * too, which is how a reply nobody actually saw goes unanswered.
 */
function NotificationsModal({
  open,
  rows,
  personOf,
  onClose,
}: {
  readonly open: boolean;
  readonly rows: readonly NotificationSummary[];
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: NOTIFICATION_COUNT_QUERY_KEY }),
    ]);

  const markAllRead = useMutation({
    mutationFn: () => apiClient.notifications.markAllRead.mutate(),
    onSuccess: refresh,
  });

  const markOneRead = useMutation({
    mutationFn: (notificationId: string) =>
      apiClient.notifications.markRead.mutate({ notificationId }),
    onSuccess: refresh,
  });

  const unread = rows.filter((row) => row.readAt === null).length;

  const openNotification = (notification: NotificationSummary): void => {
    if (notification.readAt === null) markOneRead.mutate(notification.notificationId);
    onClose();
    const path = mobileRouteFor(notification);
    if (path !== null) router.push(path);
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <View style={styles.modalHandle} />
          <View style={styles.notificationsHeader}>
            <View style={styles.notificationsHeaderTitle}>
              <Text style={styles.modalTitle}>Notifications</Text>
              {unread > 0 && (
                <View style={styles.unreadCountPill}>
                  <Text style={styles.unreadCountPillText}>{unread > 99 ? '99+' : unread}</Text>
                </View>
              )}
            </View>
            {unread > 0 && (
              <Pressable
                style={styles.markAllReadButton}
                disabled={markAllRead.isPending}
                onPress={() => {
                  markAllRead.mutate();
                }}
              >
                <Text style={styles.markAllReadText}>Mark all read</Text>
              </Pressable>
            )}
          </View>
          <ScrollView>
            {rows.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>🔔</Text>
                <Text style={styles.emptyTitle}>You&apos;re all caught up</Text>
                <Text style={styles.emptyHint}>
                  Mentions, direct messages, and assignments show up here.
                </Text>
              </View>
            ) : (
              rows.map((notification) => (
                <NotificationRow
                  key={notification.notificationId}
                  notification={notification}
                  actorLabel={
                    notification.actorId === null ? null : personOf(notification.actorId).label
                  }
                  onOpen={() => {
                    openNotification(notification);
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
    </Modal>
  );
}

function NotificationRow({
  notification,
  actorLabel,
  onOpen,
}: {
  readonly notification: NotificationSummary;
  readonly actorLabel: string | null;
  readonly onOpen: () => void;
}) {
  const unread = notification.readAt === null;

  return (
    <Pressable style={[styles.row, unread && styles.rowUnread]} onPress={onOpen}>
      <View style={styles.rowIconBadge}>
        <Text style={styles.rowIcon}>{notificationIcon(notification.kind)}</Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {notification.title}
          </Text>
          <Text style={styles.rowTime} numberOfLines={1}>
            {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
          </Text>
        </View>
        {actorLabel !== null && (
          <Text style={styles.rowActor} numberOfLines={1}>
            {actorLabel}
          </Text>
        )}
        {notification.excerpt !== null && (
          <Text style={styles.rowExcerpt} numberOfLines={2}>
            {notification.excerpt}
          </Text>
        )}
      </View>
      {unread && <View style={styles.rowUnreadDot} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /* Sized to sit inside `top-bar.tsx`'s row — no `position`/`right`/`top`
     of its own any more; see this file's own header for why that moved. */
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
  triggerText: {
    fontSize: 15,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger.hex,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    /* Not a literal '#fff' — this badge sits on `colors.danger.hex`, and
       `dangerInk` is that color's own paired ink token (verified: 5.02:1,
       passes WCAG text contrast), found during the warm-dark rebuild's own
       raw-color-literal audit (ai/design-rebuild-warm-dark.md §4). */
    color: colors.dangerInk.hex,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    paddingHorizontal: 20,
    paddingBottom: 20,
    paddingTop: 10,
    maxHeight: '75%',
  },
  /* A drag-handle affordance, not an actual drag gesture — this sheet only
     ever closes via the backdrop or "Close", but the small centered bar is
     the one glance-able signal on both platforms that this is a sheet
     rather than a dead-end popup, matching the shape every native
     bottom-sheet uses even where the gesture itself isn't wired up. */
  modalHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.2,
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
  notificationsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  notificationsHeaderTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unreadCountPill: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent.hex,
  },
  unreadCountPillText: {
    fontSize: 11,
    fontWeight: '700',
    /* Not a literal '#fff' — a real contrast bug, found and fixed during
       the warm-dark rebuild's own raw-color-literal audit
       (ai/design-rebuild-warm-dark.md §4): this pill sits on
       `colors.accent.hex`, which the rebuild lightened to L=72%, and white
       text on it measures 2.50:1 — a clear WCAG failure. `accentInk` (the
       token's own paired ink, since accent got light enough to need a dark
       one) measures 7.75:1. */
    color: colors.accentInk.hex,
  },
  markAllReadButton: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  markAllReadText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.inkMuted.hex,
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
    maxWidth: 220,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: radiusCard,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowUnread: {
    backgroundColor: colors.surfaceHover.hex,
  },
  rowIconBadge: {
    height: 28,
    width: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken.hex,
    marginTop: 1,
  },
  rowIcon: {
    fontSize: 13,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
  },
  rowTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowTime: {
    fontSize: 10,
    color: colors.inkFaint.hex,
  },
  rowActor: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  rowExcerpt: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  rowUnreadDot: {
    height: 7,
    width: 7,
    borderRadius: 3.5,
    backgroundColor: colors.accent.hex,
    marginTop: 5,
  },
});
