import { useEffect, useState, type ComponentType } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  AtSign,
  Bell,
  Mail,
  PhoneMissed,
  Reply,
  SquareCheckBig,
  type LucideProps,
} from 'lucide-react';
import { PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import type { BoardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { onNotification } from '../../lib/socket.js';
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
 * ## Polled always, pushed when a socket happens to be open (Phase 9)
 *
 * A notification can arrive from a channel, board, or Docs page this tab has
 * never joined — that is rather the point of it — so there is no ROOM
 * broadcast to ride on the way `board:{boardId}`'s events do. But every
 * authenticated socket is placed in its own personal `user:{userId}` room at
 * connection time (`apps/realtime/src/gateway.ts`, `ai/phase-9-notifications.md`
 * §3.5), with no join required — so if this tab already has a socket open for
 * some other reason (a board, a channel), a new notification invalidates these
 * queries immediately via `onNotification` below. If it does not, the
 * interval poll is the honest fallback, unchanged from before this existed —
 * `lib/socket.ts`'s own comment on `onNotification` is explicit that this
 * component mounting in the shell is not by itself a reason to force a
 * connection open on every page.
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

  useEffect(() => {
    if (orgId === '') return undefined;
    // Best-effort instant update — see the file header on why this is not
    // the only path these queries refresh on.
    return onNotification(() => {
      invalidateNotifications(queryClient, orgId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient is stable for the app's lifetime
  }, [orgId]);

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

    /* Three products, three routes — `apps/api/src/platform/notification.projection.ts`'s
       `notificationPath` builds the identical mapping server-side for email
       links; this is the same routing table, restated for the client's own
       navigation instead of an href. */
    if (notification.subjectType === 'card' && notification.boardId !== null) {
      void navigate({
        to: '/boards/$boardId',
        params: { boardId: notification.boardId as BoardId },
        search: { card: notification.subjectId },
      });
      return;
    }
    if (notification.subjectType === 'page') {
      void navigate({ to: '/docs', search: { page: notification.subjectId } });
      return;
    }
    if (notification.subjectType === 'membership') {
      void navigate({ to: '/settings' });
      return;
    }
    if (notification.channelId !== null) {
      void navigate({ to: '/chat', search: { channel: notification.channelId } });
    }
  };

  const unread = count.data?.unread ?? 0;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${String(unread)} unread` : 'Notifications'}
          className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Bell aria-hidden="true" className="size-4" strokeWidth={2} />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-xs font-semibold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={6} className="w-80 overflow-hidden">
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
              <Empty title="Nothing yet" description="Mentions and direct messages show up here." />
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
      </PopoverContent>
    </PopoverRoot>
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
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-0.5 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-1.5">
          <KindIcon kind={notification.kind} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {notification.title}
          </span>
          {notification.readAt === null && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          )}
        </span>

        {actorLabel !== null && (
          <span className="truncate text-xs text-ink-faint">{actorLabel}</span>
        )}

        {notification.excerpt !== null && (
          <span className="line-clamp-2 text-xs text-ink-muted">{notification.excerpt}</span>
        )}
      </button>
    </li>
  );
}

/**
 * The mark per notification kind — a real line icon, not an emoji.
 *
 * The bell dropdown used to carry a column of colour emoji (@, ✉️, ↩️, 📌, 📞,
 * 🔔), which render at each platform's mercy and read as a different, less
 * finished UI than the rest of the app's lucide iconography. Each kind now maps
 * to a lucide glyph, tinted with the suite hue of the thing it is about — a
 * direct message in the chat hue, a missed call in the calls hue — so a glance
 * down the list sorts the notifications by kind before a word is read. The
 * mention family shares the accent because it is not owned by one product.
 */
const KIND_ICON: Readonly<
  Record<string, { readonly icon: ComponentType<LucideProps>; readonly tint: string }>
> = {
  'chat.mention': { icon: AtSign, tint: 'text-accent' },
  'card.comment_mention': { icon: AtSign, tint: 'text-accent' },
  'page.comment_mention': { icon: AtSign, tint: 'text-accent' },
  'chat.direct': { icon: Mail, tint: 'text-chat' },
  'chat.thread_reply': { icon: Reply, tint: 'text-chat' },
  'card.assigned': { icon: SquareCheckBig, tint: 'text-accent' },
  'call.missed': { icon: PhoneMissed, tint: 'text-calls' },
};

function KindIcon({ kind }: { readonly kind: string }) {
  const entry = KIND_ICON[kind];
  const Icon = entry?.icon ?? Bell;
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', entry?.tint ?? 'text-ink-faint')}
      strokeWidth={2}
    />
  );
}
