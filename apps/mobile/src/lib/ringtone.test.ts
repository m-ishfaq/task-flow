import { describe, expect, it } from 'vitest';
import { encodeWav, RINGTONES, RINGTONE_NAMES, synthesizeToneSamples } from './ringtone.js';

const SAMPLE_RATE = 22_050;

describe('RINGTONES', () => {
  it("every beep finishes before the tone's own period — nothing gets cut off by the loop point", () => {
    for (const name of RINGTONE_NAMES) {
      const tone = RINGTONES[name];
      for (const beep of tone.beeps) {
        expect(beep.at + beep.seconds).toBeLessThanOrEqual(tone.period);
      }
    }
  });
});

describe('synthesizeToneSamples', () => {
  it("renders exactly one period's worth of samples at the fixed sample rate", () => {
    const tone = RINGTONES.classic;
    const samples = synthesizeToneSamples(tone, 0.14);
    expect(samples.length).toBe(Math.round(tone.period * SAMPLE_RATE));
  });

  it('is silent before the first beep starts', () => {
    const tone = RINGTONES.classic;
    const samples = synthesizeToneSamples(tone, 0.14);
    expect(samples[0]).toBe(0);
  });

  it('is silent in the gap between two beeps', () => {
    const tone = RINGTONES.classic;
    const samples = synthesizeToneSamples(tone, 0.14);
    // "classic": first beep ends at 0.4s, second starts at 0.45s — the
    // midpoint of that gap should still read as silence.
    const gapMidSample = Math.round(0.425 * SAMPLE_RATE);
    expect(samples[gapMidSample]).toBe(0);
  });

  it('is non-zero in the middle of a beep, once past the attack ramp', () => {
    const tone = RINGTONES.pulse;
    const beep = tone.beeps[0]!;
    const samples = synthesizeToneSamples(tone, 0.14);
    // 30% into the beep rather than the exact midpoint: at this beep's
    // frequency the midpoint sample happens to land exactly on a
    // zero-crossing of the triangle wave (phase lands on an integer), which
    // is a coincidence of the test's own sample choice, not a defect —
    // sampling off-center avoids relying on that coincidence not recurring.
    const sampleIndex = Math.round((beep.at + beep.seconds * 0.3) * SAMPLE_RATE);
    expect(Math.abs(samples[sampleIndex]!)).toBeGreaterThan(0);
  });

  it('sums two overlapping beeps rather than letting the later one silently replace the earlier one', () => {
    // "marimba" overlaps its first two beeps on purpose — a wide two-note
    // interval, not a bug (see synthesizeToneSamples's own header). A
    // renderer that WROTE instead of SUMMED would produce, in the overlap
    // region, exactly the second beep's samples alone; comparing against a
    // single-beep rendering of the same tone at the same offset is what
    // tells the two apart.
    const tone = RINGTONES.marimba;
    const secondBeep = tone.beeps[1]!;
    const overlapping = synthesizeToneSamples(tone, 0.14);
    const soloSecondBeepOnly = synthesizeToneSamples({ ...tone, beeps: [secondBeep] }, 0.14);

    // A point well inside the overlap window (both beeps' ramps long over).
    const sampleIndex = Math.round((secondBeep.at + 0.05) * SAMPLE_RATE);
    expect(overlapping[sampleIndex]).not.toBe(soloSecondBeepOnly[sampleIndex]);
  });

  it('never clips beyond the 16-bit signed range at full volume', () => {
    const tone = RINGTONES.digital;
    const samples = synthesizeToneSamples(tone, 1);
    let max = -Infinity;
    let min = Infinity;
    for (const s of samples) {
      if (s > max) max = s;
      if (s < min) min = s;
    }
    expect(max).toBeLessThanOrEqual(32_767);
    expect(min).toBeGreaterThanOrEqual(-32_768);
  }, 10_000);

  it('scales down with volume', () => {
    const tone = RINGTONES.marimba;
    const beep = tone.beeps[0]!;
    const midIndex = Math.round((beep.at + beep.seconds / 2) * SAMPLE_RATE);
    const loud = synthesizeToneSamples(tone, 1);
    const quiet = synthesizeToneSamples(tone, 0.1);
    expect(Math.abs(quiet[midIndex]!)).toBeLessThan(Math.abs(loud[midIndex]!));
  });
});

describe('encodeWav', () => {
  it('produces a valid RIFF/WAVE header for the given sample count', () => {
    const samples = new Int16Array([0, 100, -100, 32_767, -32_768]);
    const wav = encodeWav(samples);

    expect(wav.length).toBe(44 + samples.length * 2);

    const text = (offset: number, length: number): string =>
      String.fromCharCode(...wav.slice(offset, offset + length));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(text(36, 4)).toBe('data');

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('round-trips the exact sample values into the data chunk', () => {
    const samples = new Int16Array([0, 1234, -1234, 32_767, -32_768]);
    const wav = encodeWav(samples);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    for (let index = 0; index < samples.length; index += 1) {
      expect(view.getInt16(44 + index * 2, true)).toBe(samples[index]);
    }
  });
});
