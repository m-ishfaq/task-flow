/**
 * Ringtones, synthesized (ai/phase-13-webrtc.md §7).
 *
 * ## Why there are no audio files
 *
 * A shipped ringtone is a binary asset: it has to be hosted, cache-busted,
 * licensed, and it is a request that can fail — and the moment it fails, the
 * phone stops ringing with nothing to say so. Five tones at a few hundred
 * kilobytes each is also a real download for a feature most users touch rarely.
 *
 * Web Audio oscillators cost nothing, cannot 404, and make a tone a DATA
 * structure — which is what lets `identity.call_prefs.ringtone` be a short
 * enum with a CHECK constraint instead of a URL somebody's browser fetches.
 *
 * ## The tones are patterns, not melodies
 *
 * Each is a short cadence repeated on a period. Recognisability comes from the
 * rhythm and interval, not from a tune — which keeps the table readable and
 * avoids the uncanny quality of a synthesized melody.
 *
 * ## Autoplay
 *
 * A browser refuses to start an AudioContext without a user gesture. That is
 * fine for the CALLER (they clicked "call") and a real constraint for the
 * CALLEE, who has not interacted with the tab. `start()` resumes a suspended
 * context and reports whether it actually made a sound, so the UI can fall back
 * to a visual-only alert rather than silently believing it rang.
 */

export type RingtoneName = 'classic' | 'chime' | 'pulse' | 'marimba' | 'digital';

/** A single beep: a frequency, when it starts, and how long it lasts. */
interface Beep {
  readonly hz: number;
  /** Seconds from the start of one cadence. */
  readonly at: number;
  readonly seconds: number;
}

interface Tone {
  readonly label: string;
  readonly description: string;
  /** How often the cadence repeats, in seconds. */
  readonly period: number;
  readonly beeps: readonly Beep[];
  /** Oscillator shape. `sine` is soft, `square` is a device, `triangle` is in between. */
  readonly wave: OscillatorType;
}

/**
 * The closed set, matching `call_prefs_ringtone_valid` in migration 0042.
 *
 * The database's CHECK is the enforcement; this table is what the enum MEANS,
 * and the two are kept in step by the router deriving its Zod schema from the
 * schema mirror rather than from either of them.
 */
export const RINGTONES: Readonly<Record<RingtoneName, Tone>> = {
  /* Two rising notes, twice — the cadence a desk phone trained everyone on. */
  classic: {
    label: 'Classic',
    description: 'Two-tone ring, like a desk phone',
    period: 3,
    wave: 'sine',
    beeps: [
      { hz: 440, at: 0, seconds: 0.4 },
      { hz: 480, at: 0.45, seconds: 0.4 },
      { hz: 440, at: 1.0, seconds: 0.4 },
      { hz: 480, at: 1.45, seconds: 0.4 },
    ],
  },
  /* A rising major triad. Soft, and the least likely to be mistaken for an
     alarm — which matters, because the default has to be usable in an office. */
  chime: {
    label: 'Chime',
    description: 'Soft rising triad',
    period: 3.2,
    wave: 'sine',
    beeps: [
      { hz: 523.25, at: 0, seconds: 0.28 },
      { hz: 659.25, at: 0.3, seconds: 0.28 },
      { hz: 783.99, at: 0.6, seconds: 0.5 },
    ],
  },
  /* One note, repeated fast. Deliberately urgent — the tone somebody picks
     when they are away from the screen. */
  pulse: {
    label: 'Pulse',
    description: 'Insistent single note',
    period: 2,
    wave: 'triangle',
    beeps: [
      { hz: 600, at: 0, seconds: 0.16 },
      { hz: 600, at: 0.24, seconds: 0.16 },
      { hz: 600, at: 0.48, seconds: 0.16 },
    ],
  },
  /* Wide intervals with a longer decay, so it reads as wooden rather than
     electronic. */
  marimba: {
    label: 'Marimba',
    description: 'Warm, wide intervals',
    period: 2.8,
    wave: 'sine',
    beeps: [
      { hz: 392, at: 0, seconds: 0.5 },
      { hz: 587.33, at: 0.32, seconds: 0.5 },
      { hz: 392, at: 0.9, seconds: 0.5 },
    ],
  },
  /* Square wave, alternating fourths. The most obviously artificial of the
     five, which is the point — it cuts through background noise. */
  digital: {
    label: 'Digital',
    description: 'Sharp electronic alert',
    period: 2.4,
    wave: 'square',
    beeps: [
      { hz: 880, at: 0, seconds: 0.12 },
      { hz: 660, at: 0.16, seconds: 0.12 },
      { hz: 880, at: 0.32, seconds: 0.12 },
      { hz: 660, at: 0.48, seconds: 0.2 },
    ],
  },
};

export const RINGTONE_NAMES = Object.keys(RINGTONES) as readonly RingtoneName[];

/** The ringback the CALLER hears while waiting. Not a choice — see `startRingback`. */
const RINGBACK: Tone = {
  label: 'Ringback',
  description: 'What the caller hears while waiting',
  period: 4,
  wave: 'sine',
  beeps: [{ hz: 425, at: 0, seconds: 1 }],
};

/**
 * A playing tone. `stop()` is idempotent and releases the audio context.
 */
export interface Ringing {
  stop: () => void;
  /** False when the browser refused to start audio — see the header. */
  readonly audible: boolean;
}

const SILENT: Ringing = { stop: () => undefined, audible: false };

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/**
 * Plays one cadence of `tone` starting at `at`, on `context`.
 *
 * Each beep gets its own oscillator and gain node, created and discarded per
 * beep. Reusing one oscillator and re-scheduling its frequency is cheaper and
 * produces an audible click at every transition — the frequency changes
 * instantly while the waveform is mid-cycle.
 *
 * The gain envelope is what removes the click at the start and end of each
 * beep: an oscillator switched on at full amplitude is a step discontinuity,
 * which every speaker reproduces as a pop.
 */
function scheduleCadence(context: AudioContext, tone: Tone, at: number, volume: number): void {
  for (const beep of tone.beeps) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = tone.wave;
    oscillator.frequency.value = beep.hz;

    const start = at + beep.at;
    const end = start + beep.seconds;
    /* 12ms ramps. Long enough to remove the discontinuity, short enough that
       the beep still sounds like it starts when it starts. */
    const ramp = 0.012;

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + ramp);
    gain.gain.setValueAtTime(volume, Math.max(start + ramp, end - ramp));
    gain.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
}

function play(tone: Tone, volume: number): Ringing {
  const Constructor = audioContextConstructor();
  if (Constructor === undefined) return SILENT;

  let context: AudioContext;
  try {
    context = new Constructor();
  } catch {
    /* A browser with Web Audio disabled, or a context limit reached. A silent
       ring is a degraded feature; a thrown error here would take the incoming
       call banner down with it, which is much worse. */
    return SILENT;
  }

  let stopped = false;

  /* Scheduled ahead rather than driven by a timer per beep: `setInterval` in a
     background tab is throttled to once a second or worse, which would turn a
     ring into an irregular stutter exactly when somebody is not looking at the
     tab. The audio clock is not throttled, so one cadence is scheduled
     precisely and the interval only has to queue the NEXT one. */
  scheduleCadence(context, tone, context.currentTime + 0.05, volume);
  const timer = setInterval(() => {
    if (stopped) return;
    scheduleCadence(context, tone, context.currentTime + 0.05, volume);
  }, tone.period * 1000);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    /* Closing releases the audio hardware. Without it, a tab that has answered
       several calls holds a context per call until garbage collection, and
       browsers cap how many a page may have. */
    void context.close().catch(() => undefined);
  };

  /* `resume()` is what a browser demands after a user gesture. Called
     unconditionally: on a context that is already running it resolves
     immediately, and on a suspended one it is the difference between ringing
     and not. */
  void context.resume().catch(() => undefined);

  return { stop, audible: context.state !== 'suspended' };
}

/** Starts the incoming-call tone. Returns a handle to stop it. */
export function startRingtone(name: RingtoneName): Ringing {
  return play(RINGTONES[name], 0.14);
}

/**
 * Starts the ringback the CALLER hears.
 *
 * Not configurable, deliberately. A ringtone tells you which of your devices is
 * ringing and is therefore worth personalising; a ringback only has to say "it
 * is still trying", and five variants of that is a settings row nobody needs.
 * Quieter than the ringtone, because the caller is already looking at the
 * screen that says the call is connecting.
 */
export function startRingback(): Ringing {
  return play(RINGBACK, 0.05);
}

/** Plays one cadence and stops — for previewing a tone in settings. */
export function previewRingtone(name: RingtoneName): void {
  const ringing = play(RINGTONES[name], 0.14);
  const tone = RINGTONES[name];
  setTimeout(() => {
    ringing.stop();
  }, tone.period * 1000);
}
