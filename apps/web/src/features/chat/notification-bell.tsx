import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import * as Popover from '@radix-ui/react-popover';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, Empty } from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import {
  invalidateNotifications,
  markNotificationRead,
  markNotificationsRead,
  notificationCountQuery,
  notificationsQuery,
  type ChatNotification,
} from './api.js';

/**
 * The bell — mentions, direct messages, and replies to your own messages.
 *
 * ## Why the excerpt is rendered from the NOTIFICATION, not the message
 *
 * Each row carries a `title` and `excerpt` snapshotted when the notification
 * was written. Rendering from those rather than re-reading the message is what
 * makes the list correct in the two cases that matter: a message deleted by
 * retention still has a notification, and somebody removed from a private
 * channel does not have its content re-disclosed to them when they open the
 * bell. What is shown is what they were entitled to see when they were told.
 *
 * ## Polled, not pushed
 *
 * A notification arrives from a channel this tab has not joined — that is
 * rather the point of it — so there is no room broadcast to ride on. The count
 * refetches on an interval; the same half-a-minute tradeoff the unread badges
 * already accept.
 *
 * ## Clicking a row marks ONLY that row read, and opens its channel
 *
 * `markAllRead` stays as the bulk "clear the bell" action, but reading one
 * mention should not silently mark forty others read too — that is how a
 * reply you never saw goes unanswered. Navigation is self-contained (this
 * component owns its own `useNavigate` rather than taking a callback) because
 * every notification here already carries the one thing needed to route it:
 * `channelId`, snapshotted onto the row by the projection for exactly this.
 */
export function NotificationBell() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { personOf } = useMembers();
  const [open, setOpen] = useState(false);

  const count = useQuery({ ...notificationCountQuery(orgId), enabled: orgId !== '' });
  const list = useQuery({ ...notificationsQuery(orgId), enabled: orgId !== '' });

  const markAllRead = useMutation({
    mutationFn: () => markNotificationsRead(),
    onSuccess: () => {
      invalidateNotifications(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('Those could not be marked read', error);
    },
  });

  const markOneRead = useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => {
      invalidateNotifications(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That could not be marked read', error);
    },
  });

  const openNotification = (notification: ChatNotification): void => {
    if (notification.readAt === null) markOneRead.mutate(notification.notificationId);
    setOpen(false);
    if (notification.channelId !== null) {
      void navigate({ to: '/chat', search: { channel: notification.channelId } });
    }
  };

  const unread = count.data?.unread ?? 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${String(unread)} unread` : 'Notifications'}
          className="relative flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          🔔
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 overflow-hidden rounded-md border border-line bg-surface shadow-lg"
        >
          <header className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-medium text-ink">Notifications</h2>
            {unread > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={markAllRead.isPending}
                onClick={() => {
                  markAllRead.mutate();
                }}
              >
                Mark all read
              </Button>
            )}
          </header>

          <div className="max-h-96 overflow-y-auto">
            {(list.data ?? []).length === 0 ? (
              <div className="p-3">
                <Empty
                  title="Nothing yet"
                  description="Mentions and direct messages show up here."
                />
              </div>
            ) : (
              <ul>
                {(list.data ?? []).map((notification) => (
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
                ))}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NotificationRow({
  notification,
  actorLabel,
  onOpen,
}: {
  readonly notification: ChatNotification;
  readonly actorLabel: string | null;
  readonly onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        'border-b border-line last:border-b-0',
        notification.readAt === null && 'bg-accent/5',
      )}
    >
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left">
        <span className="flex items-center gap-1.5">
          <span aria-hidden>{iconFor(notification.kind)}</span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {notification.title}
          </span>
          {notification.readAt === null && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          )}
        </span>

        {actorLabel !== null && (
          <span className="truncate text-[11px] text-ink-faint">{actorLabel}</span>
        )}

        {notification.excerpt !== null && (
          <span className="line-clamp-2 text-xs text-ink-muted">{notification.excerpt}</span>
        )}
      </button>
    </li>
  );
}

/** A glyph per kind. Kept here rather than on the row: it is presentation. */
function iconFor(kind: string): string {
  if (kind === 'chat.mention') return '@';
  if (kind === 'chat.direct') return '✉️';
  return '↩️';
}
