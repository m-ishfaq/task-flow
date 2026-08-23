import type * as ExpoAudio from 'expo-audio';
import type * as ExpoFileSystem from 'expo-file-system';
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
 * ## `expo-audio` and `expo-file-system` are imported dynamically, inside `play`
 *
 * Both packages' own entry points call `requireNativeModule(...)` at MODULE
 * TOP LEVEL — `ExpoAudio.ts`: `export default requireNativeModule('ExpoAudio')`,
 * `ExpoFileSystem.ts`: the identical shape for `'FileSystem'` — which throws
 * synchronously the moment either package is imported, on any build where
 * its native module is not linked. `call-surface.tsx` and
 * `ringtone-section.tsx` reach this file from `(app)/_layout.tsx` and the
 * account screen respectively, both mounted for every route, so a top-level
 * value import here (the first version of this file had one) poisoned the
 * ENTIRE route tree on such a build, not just ringing — confirmed directly,
 * not merely reasoned about: a real dev-client run produced exactly `Error:
 * Cannot find native module 'ExpoAudio'` immediately followed by
 * `(app)/_layout.tsx` and the account route both "missing the required
 * default export". The identical failure mode `use-call.ts`'s own header
 * documents for `react-native-webrtc`, and the one `modules/device-key/
 * index.ts` was built to defer against from the start with `getNative()`'s
 * first-use memoization — this file just hadn't been held to the same rule
 * yet, twice over (both native packages it touches, not only one).
 *
 * `getNative()` below is this file's version of that deferral: both
 * packages are resolved together, once, on the first call to `play()` —
 * never at import time. That is also why `startRingtone`/`startRingback`/
 * `previewRingtone` are `async` where the web equivalents are not: there is
 * no way to defer a possible throw to first use while keeping the call
 * synchronous. `call-surface.tsx`'s two ringing effects and
 * `ringtone-section.tsx`'s preview button both await it.
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

interface NativeAudio {
  readonly File: typeof ExpoFileSystem.File;
  readonly Paths: typeof ExpoFileSystem.Paths;
  readonly createAudioPlayer: typeof ExpoAudio.createAudioPlayer;
  readonly setAudioModeAsync: typeof ExpoAudio.setAudioModeAsync;
}

let native: NativeAudio | null = null;

/** Resolves both native packages on first USE, not on import — see the module header. */
async function getNative(): Promise<NativeAudio> {
  if (native !== null) return native;
  const [fileSystem, audio] = await Promise.all([import('expo-file-system'), import('expo-audio')]);
  native = {
    File: fileSystem.File,
    Paths: fileSystem.Paths,
    createAudioPlayer: audio.createAudioPlayer,
    setAudioModeAsync: audio.setAudioModeAsync,
  };
  return native;
}

const fileCache = new Map<string, ExpoFileSystem.File>();

/**
 * The on-disk WAV for one tone, rendered and written on first use only.
 * `RINGTONE_NAMES` plus `'ringback'` is a closed, five-plus-one set, so
 * this never grows without bound.
 */
function ringtoneFile(
  deps: NativeAudio,
  key: string,
  tone: Tone,
  volume: number,
): ExpoFileSystem.File {
  const cached = fileCache.get(key);
  if (cached !== undefined) return cached;

  const file = new deps.File(deps.Paths.cache, `ringtone-${key}.wav`);
  if (!file.exists) {
    file.create({ intermediates: true });
    file.write(encodeWav(synthesizeToneSamples(tone, volume)));
  }
  fileCache.set(key, file);
  return file;
}

async function play(key: string, tone: Tone, volume: number): Promise<Ringing> {
  try {
    const deps = await getNative();
    const file = ringtoneFile(deps, key, tone, volume);
    /* Real calling-app behavior: a ring or ringback should sound even
       through the hardware silent switch, the same reason every phone
       dialer does. Called on every play rather than once at app start, so
       it never fights with some other screen's own audio-mode choice. */
    void deps.setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);

    const player = deps.createAudioPlayer({ uri: file.uri });
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
    /* A device with no audio output, a native module that isn't linked, a
       filesystem write failure, or a player construction error. A silent
       ring is a degraded feature; a thrown error here would take the
       incoming-call banner down with it — the same trade web's own
       `play()` makes for a disabled Web Audio context. */
    return SILENT;
  }
}

/* Same amplitude constants as web's own `startRingtone`/`startRingback` —
   unverified on a real device (no speaker to listen through in this
   sandbox), so ported exactly rather than guessed at again from scratch. */
const RINGTONE_VOLUME = 0.14;
const RINGBACK_VOLUME = 0.05;

/** Starts the incoming-call tone. Returns a handle to stop it. */
export async function startRingtone(name: RingtoneName): Promise<Ringing> {
  return play(name, RINGTONES[name], RINGTONE_VOLUME);
}

/**
 * Starts the ringback the CALLER hears. Not configurable — see web's
 * identical reasoning: a ringback only has to say "still trying".
 */
export async function startRingback(): Promise<Ringing> {
  return play('ringback', RINGBACK, RINGBACK_VOLUME);
}

/** Plays one cadence and stops — for previewing a tone in settings. */
export async function previewRingtone(name: RingtoneName): Promise<void> {
  const tone = RINGTONES[name];
  const ringing = await play(name, tone, RINGTONE_VOLUME);
  setTimeout(() => {
    ringing.stop();
  }, tone.period * 1000);
}
