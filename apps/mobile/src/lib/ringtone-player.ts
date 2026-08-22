import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import {
  encodeWav,
  RINGBACK,
  RINGTONES,
  synthesizeToneSamples,
  type RingtoneName,
  type Tone,
} from './ringtone.js';

/**
 * The device-facing half of ringtones (ai/phase-13-webrtc.md §7) —
 * `ringtone.ts`'s pure WAV synthesis, played back through `expo-audio`.
 * Kept in its own file, deliberately with no unit test, for the identical
 * boundary `ringtone.ts`'s own header names: importing `expo-audio` pulls
 * in Expo's runtime setup, which throws under Vitest's plain Node
 * environment. This file is exactly the two-tier split ai/phase-14-
 * mobile.md §11 already draws everywhere else in this app — what CI can
 * prove stops at the WAV bytes; only a device can prove they play.
 *
 * ## Written to a file, not played from a `data:` URI
 *
 * A `data:` URI is not reliably supported by the native players
 * `expo-audio` sits on (`AVPlayer` on iOS, `ExoPlayer`/`MediaPlayer` on
 * Android both expect a `file://`/`http(s)://` resource, not an inline
 * scheme) — untested and unverifiable in this sandbox with no device to
 * confirm it either way, so this takes the path both platforms are
 * DOCUMENTED to support instead. The WAV bytes are still "nothing to host,
 * nothing that can 404" in spirit: generated in memory, written to this
 * app's own cache directory, never fetched from anywhere. Each of the five
 * tones (plus the ringback) is rendered once and cached on disk for the
 * life of the app — `ringtoneFile` memoizes the `File` instance per name so
 * a call that rings twice does not regenerate and rewrite the same bytes
 * twice.
 *
 * ## `audible` is always `true` once playback starts
 *
 * Web's version reports whether the browser's autoplay policy actually let
 * the tone sound, since a callee's tab has had no user gesture. Native
 * audio has no equivalent autoplay restriction to report on — `Ringing`
 * keeps the field for the same call-site shape, set `false` only when
 * starting the player itself threw (a genuinely silent, degraded ring
 * rather than a crashed one).
 */

/** A playing tone. `stop()` is idempotent. */
export interface Ringing {
  stop: () => void;
  /** False only when starting playback itself threw — see the module header. */
  readonly audible: boolean;
}

const SILENT: Ringing = { stop: () => undefined, audible: false };

const fileCache = new Map<string, File>();

/**
 * The on-disk WAV for one tone, rendered and written on first use only.
 * `RINGTONE_NAMES` plus `'ringback'` is a closed, five-plus-one set, so
 * this never grows without bound.
 */
function ringtoneFile(key: string, tone: Tone, volume: number): File {
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;

  const file = new File(Paths.cache, `ringtone-${key}.wav`);
  if (!file.exists) {
    file.create({ intermediates: true });
    file.write(encodeWav(synthesizeToneSamples(tone, volume)));
  }
  fileCache.set(key, file);
  return file;
}

function play(key: string, tone: Tone, volume: number): Ringing {
  try {
    const file = ringtoneFile(key, tone, volume);
    /* Real calling-app behavior: a ring or ringback should sound even
       through the hardware silent switch, the same reason every phone
       dialer does. Called on every play rather than once at app start, so
       it never fights with some other screen's own audio-mode choice. */
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);

    const player = createAudioPlayer({ uri: file.uri });
    player.loop = true;
    player.play();

    let stopped = false;
    return {
      audible: true,
      stop: () => {
        if (stopped) return;
        stopped = true;
        player.pause();
        player.remove();
      },
    };
  } catch {
    /* A device with no audio output, a filesystem write failure, or a
       player construction error. A silent ring is a degraded feature; a
       thrown error here would take the incoming-call banner down with
       it — the same trade web's own `play()` makes for a disabled Web
       Audio context. */
    return SILENT;
  }
}

/* Same amplitude constants as web's own `startRingtone`/`startRingback` —
   unverified on a real device (no speaker to listen through in this
   sandbox), so ported exactly rather than guessed at again from scratch. */
const RINGTONE_VOLUME = 0.14;
const RINGBACK_VOLUME = 0.05;

/** Starts the incoming-call tone. Returns a handle to stop it. */
export function startRingtone(name: RingtoneName): Ringing {
  return play(name, RINGTONES[name], RINGTONE_VOLUME);
}

/**
 * Starts the ringback the CALLER hears. Not configurable — see web's
 * identical reasoning: a ringback only has to say "still trying".
 */
export function startRingback(): Ringing {
  return play('ringback', RINGBACK, RINGBACK_VOLUME);
}

/** Plays one cadence and stops — for previewing a tone in settings. */
export function previewRingtone(name: RingtoneName): void {
  const tone = RINGTONES[name];
  const ringing = play(name, tone, RINGTONE_VOLUME);
  setTimeout(() => {
    ringing.stop();
  }, tone.period * 1000);
}
