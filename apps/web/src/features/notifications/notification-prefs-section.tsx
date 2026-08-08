import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Section, SkeletonRows, Button } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import {
  notificationPrefsQuery,
  pushDevicesQuery,
  pushVapidKeyQuery,
  setNotificationPref,
  unregisterPushDevice,
  type NotificationCategory,
  type NotificationChannel,
} from './api.js';
import { browserPushStatus, disablePushOnThisBrowser, enablePushOnThisBrowser } from './push.js';

/**
 * Notification preferences, on the account page (Phase 9, ai/phase-9-notifications.md §3.3).
 *
 * ## Lives on `/account`, not a per-org settings page
 *
 * `identity.notification_prefs` is global per user — the same "yours alone...
 * the same wherever you sign in" shape `AccountSection`'s display name and
 * `PasskeySection` already have on this page (`account-page.tsx`'s own
 * header). A per-org settings page would imply these vary by org, and they
 * do not.
 *
 * ## The push column is honest about every reason it cannot work
 *
 * Wave 1 showed push disabled with a single "coming soon" label. Wave 2
 * ships the real ceremony, so the disabled state now has three distinct
 * honest causes: the server has no VAPID keys configured, this browser does
 * not support push, or the browser's own notification permission is blocked.
 * Each is shown as its own reason rather than a generic "off" — a toggle
 * that is greyed out with no explanation reads as broken. Turning push ON
 * runs the full ceremony (`enablePushOnThisBrowser`) before saving the
 * preference, so a checkbox that flips but delivers nothing cannot happen:
 * the ceremony failing (denied permission, unconfigured server) reverts the
 * box and says why.
 *
 * ## SMS stays honestly unsupported
 *
 * No SMS provider exists until Phase 7, so that column keeps its "coming
 * soon" disabled state — saving a preference nothing would ever act on is
 * the same silent lie this page exists to avoid.
 */

interface CategoryOption {
  readonly value: NotificationCategory;
  readonly label: string;
  readonly description: string;
}

const CATEGORIES: readonly CategoryOption[] = [
  {
    value: 'direct',
    label: 'Mentions, DMs & assignments',
    description: 'Someone @mentioned you, sent you a direct message, or assigned you a card.',
  },
  {
    value: 'activity',
    label: 'Replies, comments & due dates',
    description: 'Replies to your own messages, other comments, and cards coming due.',
  },
];

interface ChannelOption {
  readonly value: NotificationChannel;
  readonly label: string;
  /** When set, the column is disabled and this reason is shown under it. */
  readonly disabledReason?: string;
}

const CHANNELS: readonly ChannelOption[] = [
  { value: 'email', label: 'Email' },
  {
    value: 'push',
    label: 'Push',
    // Replaced below by the real, state-dependent reason when push is off.
    disabledReason: 'Push is not configured on this server.',
  },
  {
    value: 'sms',
    label: 'SMS',
    disabledReason: 'Coming soon — SMS depends on Phase 7 (Voice & Messaging).',
  },
];

export function NotificationPreferencesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = notificationPrefsQuery();
  const prefs = useQuery(query);

  const vapidQuery = pushVapidKeyQuery();
  const devicesQuery = pushDevicesQuery();
  const vapid = useQuery(vapidQuery);
  const devices = useQuery(devicesQuery);

  const setPref = useMutation({
    mutationFn: setNotificationPref,
    // Optimistic: a checkbox that waits for a round trip before flipping
    // reads as broken on a slow connection, for a toggle this low-stakes.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: query.queryKey });
      const previous = queryClient.getQueryData(query.queryKey);

      queryClient.setQueryData(query.queryKey, (current) =>
        current?.map((entry) =>
          entry.category === input.category && entry.channel === input.channel
            ? { ...entry, enabled: input.enabled }
            : entry,
        ),
      );

      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(query.queryKey, context.previous);
      }
      toast.failure('That preference could not be saved', error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });

  const removeDevice = useMutation({
    mutationFn: unregisterPushDevice,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey });
    },
    onError: (error) => {
      toast.failure('That device could not be removed', error);
    },
  });

  /* The real push-disabled reason, in priority order: server, browser,
     permission. Computed once here so both the matrix and the device list
     agree on what "off" means. */
  const pushStatus = browserPushStatus();
  const pushConfigured = vapid.data?.publicKey !== null && vapid.data?.publicKey !== undefined;
  const pushDisabledReason =
    vapid.isPending || vapid.isError
      ? undefined // treated as disabled below, without claiming to know why
      : !pushConfigured
        ? 'Push is not configured on this server.'
        : !pushStatus.supported
          ? 'This browser does not support push notifications.'
          : pushStatus.permission === 'denied'
            ? 'Notifications are blocked for this site in your browser settings.'
            : undefined;

  const pushOn = prefs.data?.some((entry) => entry.channel === 'push' && entry.enabled) ?? false;

  if (prefs.isPending) return <SkeletonRows rows={2} className="*:h-16" />;
  if (prefs.isError) {
    return <ErrorView error={prefs.error} title="Could not load notification preferences" />;
  }

  const enabledFor = (category: NotificationCategory, channel: NotificationChannel): boolean =>
    prefs.data.find((entry) => entry.category === category && entry.channel === channel)?.enabled ??
    false;

  const channels = CHANNELS.map((channel) =>
    channel.value === 'push' ? { ...channel, disabledReason: pushDisabledReason } : channel,
  );

  return (
    <Section
      title="Notifications"
      description="How you're told about mentions, assignments, and activity, wherever you sign in."
    >
      <div className="flex flex-col gap-4">
        {CATEGORIES.map((category) => (
          <div key={category.value} className="flex flex-col gap-2">
            <div>
              <p className="text-sm font-medium text-ink">{category.label}</p>
              <p className="text-xs text-ink-muted">{category.description}</p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {channels.map((channel) => (
                <div key={channel.value} className="flex flex-col gap-1">
                  <label
                    className="flex items-center gap-2 text-sm text-ink"
                    title={channel.disabledReason}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-line accent-accent disabled:opacity-50"
                      checked={enabledFor(category.value, channel.value)}
                      disabled={setPref.isPending || channel.disabledReason !== undefined}
                      onChange={(event) => {
                        const enabled = event.target.checked;

                        /* Push needs the full ceremony BEFORE the preference is
                           saved — a checkbox that flips but delivers nothing is
                           exactly the silent lie this page avoids. A refused
                           ceremony (denied permission, unconfigured server)
                           keeps the box where it was and says why. */
                        if (channel.value === 'push' && enabled) {
                          void enablePushOnThisBrowser()
                            .then(() => {
                              setPref.mutate({
                                category: category.value,
                                channel: channel.value,
                                enabled,
                              });
                            })
                            .catch((error: unknown) => {
                              toast.failure('Push could not be enabled on this browser', error);
                              void queryClient.invalidateQueries({
                                queryKey: devicesQuery.queryKey,
                              });
                            });
                          return;
                        }

                        /* Turning push OFF unsubscribes this browser as well as
                           clearing the preference — the mirror image of the
                           ceremony above, and the only channel where a
                           preference change has a side effect on a device. */
                        if (channel.value === 'push' && !enabled) {
                          void disablePushOnThisBrowser()
                            .catch(() => {
                              // The server row is already removed by the
                              // ceremony itself; a local failure is not worth
                              // a toast.
                            })
                            .finally(() => {
                              setPref.mutate({
                                category: category.value,
                                channel: channel.value,
                                enabled,
                              });
                            });
                          return;
                        }

                        setPref.mutate({
                          category: category.value,
                          channel: channel.value,
                          enabled,
                        });
                      }}
                    />
                    <span
                      className={
                        channel.disabledReason === undefined ? undefined : 'text-ink-faint'
                      }
                    >
                      {channel.label}
                    </span>
                  </label>
                  {channel.disabledReason !== undefined && (
                    <p className="max-w-44 pl-6 text-[11px] leading-tight text-ink-faint">
                      {channel.disabledReason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {pushOn && devices.data !== undefined && devices.data.length > 0 && (
          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-ink">Push devices</p>
              <span className="text-xs text-ink-faint">{devices.data.length} registered</span>
            </div>
            <p className="text-xs text-ink-muted">
              Push is delivered to the browsers you've enabled below.
            </p>
            <ul className="flex flex-col gap-1">
              {devices.data.map((device) => (
                <li
                  key={device.subscriptionId}
                  className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"
                >
                  <span className="text-ink">{device.userAgentLabel ?? 'Unknown browser'}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={removeDevice.isPending}
                    onClick={() => {
                      removeDevice.mutate(device.subscriptionId);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
