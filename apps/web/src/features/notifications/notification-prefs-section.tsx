import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useToast } from '../../lib/toast-context.js';
import {
  notificationPrefsQuery,
  setNotificationPref,
  type NotificationCategory,
  type NotificationChannel,
} from './api.js';

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
 * ## Push and SMS are shown, not hidden — and disabled, not lying
 *
 * Wave 1 only wires email. Hiding the other two columns would look like a
 * smaller feature than the schema already supports (`identity.notification_prefs`
 * already has a `channel` CHECK admitting all three — see that table's own
 * comment); showing them as checkboxes a person could toggle whose value is
 * saved but has literally no effect yet would be worse — a silent lie about
 * what "on" does. Disabled with a reason is the honest middle ground.
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
  readonly comingSoon?: string;
}

const CHANNELS: readonly ChannelOption[] = [
  { value: 'email', label: 'Email' },
  { value: 'push', label: 'Push', comingSoon: 'Coming soon — no browser push provider yet.' },
  {
    value: 'sms',
    label: 'SMS',
    comingSoon: 'Coming soon — depends on Phase 7 (Voice & Messaging).',
  },
];

export function NotificationPreferencesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = notificationPrefsQuery();
  const prefs = useQuery(query);

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

  if (prefs.isPending) return <SkeletonRows rows={2} className="*:h-16" />;
  if (prefs.isError) {
    return <ErrorView error={prefs.error} title="Could not load notification preferences" />;
  }

  const enabledFor = (category: NotificationCategory, channel: NotificationChannel): boolean =>
    prefs.data.find((entry) => entry.category === category && entry.channel === channel)?.enabled ??
    false;

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
            <div className="flex flex-wrap gap-4">
              {CHANNELS.map((channel) => (
                <label
                  key={channel.value}
                  className="flex items-center gap-2 text-sm text-ink"
                  title={channel.comingSoon}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-line accent-accent disabled:opacity-50"
                    checked={enabledFor(category.value, channel.value)}
                    disabled={setPref.isPending || channel.comingSoon !== undefined}
                    onChange={(event) => {
                      setPref.mutate({
                        category: category.value,
                        channel: channel.value,
                        enabled: event.target.checked,
                      });
                    }}
                  />
                  <span className={channel.comingSoon === undefined ? undefined : 'text-ink-faint'}>
                    {channel.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
