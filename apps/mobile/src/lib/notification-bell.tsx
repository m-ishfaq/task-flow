import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
 * `apps/web/src/features/chat/notification-bell.tsx`; the UI itself
 * (`NotificationsModal`/`NotificationRow` below) is unchanged from where it
 * first landed on this platform — `(tabs)/chat.tsx`'s own title row — only
 * WHERE it is mounted moved.
 *
 * ## Reachable from every tab now, not just Chat
 *
 * `notifications.ts`'s own header used to name this as "the one real,
 * stated divergence from web": web mounts its bell once in `shell.tsx`,
 * visible on every route, while this app had "no single shared chrome to
 * mount an equivalent in without touching all four tab screens" — true when
 * written, and now stale, corrected in place per this repo's own habit
 * rather than silently rewritten: `call-surface.tsx` has since proven that
 * chrome exists. `(app)/_layout.tsx` already mounts it once, above the
 * `<Stack>`, specifically so a ringing call is answerable regardless of
 * which tab is open — this component rides the identical pattern, a
 * SECOND absolutely-positioned overlay a real device report found the
 * first one still didn't cover ("notification is on chat layout, can't get
 * to it").
 *
 * ## Positioned inside the safe-area gap, not fighting each screen's own header
 *
 * Every tab screen already draws its own title row starting at
 * `useTopInset()` — the safe-area top inset PLUS 24px of deliberate
 * breathing room (`use-top-inset.ts`'s own header). That 24px band is
 * reserved whitespace by construction, not un-owned space to guess at: a
 * small icon-only button anchored at the raw safe-area edge (no `+ 24`)
 * sits entirely within it, above every screen's actual content, on every
 * tab, without touching any of the four screens that already render there.
 * `zIndex`/`elevation` keep it above content that might otherwise scroll
 * beneath the safe-area padding.
 */
export function NotificationBell(): React.JSX.Element {
  const insets = useSafeAreaInsets();
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
        style={[styles.trigger, { top: insets.top + 4 }]}
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
          <View style={styles.notificationsHeader}>
            <Text style={styles.modalTitle}>Notifications</Text>
            {unread > 0 && (
              <Pressable
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
              <Text style={styles.label}>Mentions and direct messages show up here.</Text>
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
  return (
    <Pressable
      style={[styles.row, notification.readAt === null && styles.rowUnread]}
      onPress={onOpen}
    >
      <View style={styles.rowTop}>
        <Text style={styles.rowIcon}>{notificationIcon(notification.kind)}</Text>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {notification.title}
        </Text>
      </View>
      {actorLabel !== null && (
        <Text style={styles.rowTime} numberOfLines={1}>
          {actorLabel}
        </Text>
      )}
      {notification.excerpt !== null && (
        <Text style={styles.rowExcerpt} numberOfLines={2}>
          {notification.excerpt}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    position: 'absolute',
    right: 16,
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised.hex,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    zIndex: 20,
    elevation: 20,
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
    color: '#fff',
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
    maxHeight: '75%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 12,
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
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  notificationsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  markAllReadText: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  row: {
    gap: 4,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowUnread: {
    backgroundColor: colors.surfaceHover.hex,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowIcon: {
    fontSize: 13,
  },
  rowTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowTime: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  rowExcerpt: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
});
