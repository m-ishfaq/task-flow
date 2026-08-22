/**
 * Ringtone synthesis — the pure half (ai/phase-13-webrtc.md §7), ported
 * from `apps/web/src/features/rtc/ringtone.ts`. The TONE TABLE below —
 * frequencies, cadence timing, envelope shape — is copied verbatim from
 * that file; only the RENDERING differs, because React Native has no Web
 * Audio API to schedule oscillators against in real time.
 *
 * Deliberately free of any Expo/native import. `ringtone-player.ts` is the
 * thin device-facing half (WAV-to-file, `expo-audio` playback) — split out
 * the same way `secure-store.ts`/`device-secure-store.ts` already split
 * this app's port/native-impl pairs, and for the identical reason:
 * `expo-audio` transitively pulls in Expo's own runtime setup, which
 * references the React-Native-only `__DEV__` global and throws immediately
 * on import under Vitest's plain Node environment — confirmed directly (a
 * first attempt at one combined file failed every test in this suite with
 * `ReferenceError: __DEV__ is not defined`, not a single assertion of its
 * own). Keeping the actual DSP here, with no such import, is what makes
 * `synthesizeToneSamples`/`encodeWav` unit-testable at all.
 *
 * ## Rendered to a WAV buffer, not scheduled live
 *
 * Web builds each cadence from live `OscillatorNode`s, re-scheduled on a
 * timer every `period` seconds — impossible here with no `AudioContext`.
 * `synthesizeToneSamples` instead renders ONE FULL PERIOD (every beep plus
 * the silence between them) into 16-bit PCM samples up front, and
 * `ringtone-player.ts` loops that single buffer — a looping `AudioPlayer`
 * reproduces the exact same repeating cadence a rescheduled oscillator
 * would, with no per-cycle JS work once the file exists. The gain envelope
 * (a 12ms linear ramp in and out of each beep) is copied unchanged for the
 * identical reason web's own comment gives: a beep switched on at full
 * amplitude is a step discontinuity, audible as a click on every speaker.
 */

export type RingtoneName = 'classic' | 'chime' | 'pulse' | 'marimba' | 'digital';

/** A single beep: a frequency, when it starts, and how long it lasts. */
export interface Beep {
  readonly hz: number;
  /** Seconds from the start of one cadence. */
  readonly at: number;
  readonly seconds: number;
}

export type Wave = 'sine' | 'square' | 'triangle';

export interface Tone {
  readonly label: string;
  readonly description: string;
  /** How often the cadence repeats, in seconds — and the rendered buffer's own length. */
  readonly period: number;
  readonly beeps: readonly Beep[];
  readonly wave: Wave;
}

/**
 * The closed set, matching `call_prefs_ringtone_valid` in migration 0042 —
 * identical table to web's own `RINGTONES`, restated here rather than
 * shared, since sharing would mean a cross-platform package for five
 * constant objects neither app can consume the other's rendering of.
 */
export const RINGTONES: Readonly<Record<RingtoneName, Tone>> = {
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

/** The ringback the CALLER hears while waiting. Not a choice — see `ringtone-player.ts`'s `startRingback`. */
export const RINGBACK: Tone = {
  label: 'Ringback',
  description: 'What the caller hears while waiting',
  period: 4,
  wave: 'sine',
  beeps: [{ hz: 425, at: 0, seconds: 1 }],
};

export const RINGTONE_SAMPLE_RATE = 22_050;
/* 12ms ramps, matching web's own envelope exactly — long enough to remove
   the discontinuity, short enough that the beep still sounds like it
   starts when it starts. */
const RAMP_SECONDS = 0.012;

function waveSample(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'square':
      return phase % 1 < 0.5 ? 1 : -1;
    case 'triangle':
      return 4 * Math.abs((((phase % 1) + 1.25) % 1) - 0.5) - 1;
  }
}

/**
 * Renders one full cadence period of `tone` into 16-bit PCM samples at
 * `RINGTONE_SAMPLE_RATE`, mono. Pure — no native dependency, no I/O — which
 * is what lets `ringtone.test.ts` assert its output directly (silence
 * between beeps, the correct sample count for `period`, no discontinuity
 * at a beep's edges) with no device and no mocked native module.
 *
 * Beeps are SUMMED into a float accumulator, not written directly into the
 * int16 output — `marimba`'s own table overlaps two notes on purpose (a
 * wide two-note interval, not a bug: the second beep starts at 0.32s while
 * the first is still ringing until 0.5s), the same way two simultaneous
 * `OscillatorNode`s mix at a Web Audio destination on web. Writing each
 * beep directly into the int16 array would make the SECOND beep silently
 * replace the first for the overlap's duration instead of mixing with it —
 * found by `ringtone.test.ts`'s own overlap-detecting test, which is kept
 * as a check on the table rather than an assumption the renderer gets to
 * make. Quantizing to int16 once at the end, after every beep has been
 * summed, is also why volume is clamped only here and not per beep.
 */
export function synthesizeToneSamples(tone: Tone, volume: number): Int16Array {
  const totalSamples = Math.round(tone.period * RINGTONE_SAMPLE_RATE);
  const accumulator = new Float64Array(totalSamples);

  for (const beep of tone.beeps) {
    const startSample = Math.round(beep.at * RINGTONE_SAMPLE_RATE);
    const endSample = Math.min(
      totalSamples,
      Math.round((beep.at + beep.seconds) * RINGTONE_SAMPLE_RATE),
    );
    const rampSamples = Math.round(RAMP_SECONDS * RINGTONE_SAMPLE_RATE);

    for (let index = startSample; index < endSample; index += 1) {
      const sinceStart = index - startSample;
      const untilEnd = endSample - index;
      /* The same envelope shape as web's `gain.gain.setValueAtTime`/
         `linearRampToValueAtTime` calls: 0 -> volume over the first ramp,
         held, then volume -> 0 over the last ramp. */
      const envelope = Math.min(1, sinceStart / rampSamples, untilEnd / rampSamples);
      const phase = ((index - startSample) * beep.hz) / RINGTONE_SAMPLE_RATE;
      accumulator[index] =
        (accumulator[index] ?? 0) + waveSample(tone.wave, phase) * envelope * volume;
    }
  }

  const samples = new Int16Array(totalSamples);
  for (let index = 0; index < totalSamples; index += 1) {
    samples[index] = Math.max(
      -32_768,
      Math.min(32_767, Math.round((accumulator[index] ?? 0) * 32_767)),
    );
  }
  return samples;
}

/** Wraps `samples` in a standard 44-byte mono 16-bit PCM WAV header. */
export function encodeWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RINGTONE_SAMPLE_RATE, true);
  view.setUint32(28, RINGTONE_SAMPLE_RATE * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, samples[index] ?? 0, true);
  }

  return new Uint8Array(buffer);
}
