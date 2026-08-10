import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { cn } from '../../lib/cn.js';
import { Skeleton } from '../../components/primitives.js';
import { callPrefsQuery, invalidateCallPrefs } from './api.js';
import { previewRingtone, RINGTONE_NAMES, RINGTONES, type RingtoneName } from './ringtone.js';

/**
 * Choosing a ringtone (ai/phase-13-webrtc.md §7).
 *
 * Lives on the ACCOUNT page, next to notification preferences, because it is
 * the same kind of setting: global per user, not per org, "yours alone and the
 * same wherever you sign in". `identity.call_prefs` is keyed that way for
 * exactly this reason — see migration 0042.
 *
 * ## Every tone previews on click
 *
 * A tone is a sound. A list of five names with no way to hear them is a choice
 * nobody can make, so selecting one plays a single cadence — which also serves
 * as the user gesture a browser needs before it will let this page produce
 * audio at all, so somebody who has visited this page once has already granted
 * the permission their next incoming call depends on.
 */
export function RingtoneSection() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const prefs = useQuery(callPrefsQuery());

  const save = useMutation({
    mutationFn: (next: { ringtone: RingtoneName; ringEnabled: boolean }) =>
      api.rtc.prefs.set.mutate(next),
    onSuccess: async () => {
      await invalidateCallPrefs(queryClient);
    },
    onError: (error) => {
      toast.failure('Your ringtone was not saved', error);
    },
  });

  const current: RingtoneName = prefs.data?.ringtone ?? 'classic';
  const ringEnabled = prefs.data?.ringEnabled ?? true;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-ink">Ringtone</h2>
        <p className="text-xs text-ink-muted">
          What you hear when somebody calls you in TaskFlow. Select one to preview it.
        </p>
      </div>

      {prefs.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {RINGTONE_NAMES.map((name) => {
              const tone = RINGTONES[name];
              const selected = name === current;

              return (
                <li key={name}>
                  <button
                    type="button"
                    disabled={save.isPending}
                    onClick={() => {
                      /* Previewed BEFORE the save resolves. The sound is the
                         feedback — waiting for a round trip to play it makes
                         the list feel broken on a slow connection. */
                      previewRingtone(name);
                      save.mutate({ ringtone: name, ringEnabled });
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left',
                      selected
                        ? 'border-accent bg-accent/10'
                        : 'border-line hover:bg-surface-hover',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                        selected ? 'border-accent bg-accent' : 'border-line',
                      )}
                      aria-hidden="true"
                    >
                      {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent-ink" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink">{tone.label}</span>
                      <span className="block text-xs text-ink-faint">{tone.description}</span>
                    </span>
                    <span aria-hidden="true" className="text-xs text-ink-faint">
                      ▶
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={ringEnabled}
              disabled={save.isPending}
              onChange={(event) => {
                save.mutate({ ringtone: current, ringEnabled: event.target.checked });
              }}
            />
            Play a sound for incoming calls
          </label>
          {/* Deliberately explicit that this is not "do not disturb". Somebody
              in an open-plan office wants to be TOLD without announcing it to
              the room, and folding the two together would make "stop the
              noise" mean "stop telling me". */}
          <p className="text-xs text-ink-faint">
            Turning this off keeps the on-screen call alert — it only silences the tone.
          </p>
        </>
      )}
    </section>
  );
}
