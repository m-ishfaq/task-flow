import { describe, expect, it } from 'vitest';
import { callStatusLabel, durationLabel } from './telephony.js';

describe('callStatusLabel', () => {
  it('resolves a known carrier status to its label', () => {
    expect(callStatusLabel('in_progress')).toBe('In progress');
    expect(callStatusLabel('no_answer')).toBe('No answer');
  });

  it('title-cases an unknown status rather than leaving it raw', () => {
    expect(callStatusLabel('unknown_status')).toBe('Unknown_status');
  });
});

describe('durationLabel', () => {
  it('renders seconds alone under a minute', () => {
    expect(durationLabel(45)).toBe('45s');
  });

  it('renders minutes and zero-padded seconds at or above a minute', () => {
    expect(durationLabel(64)).toBe('1m 04s');
  });

  it('zero-pads a whole minute to :00', () => {
    expect(durationLabel(120)).toBe('2m 00s');
  });

  it('renders zero as 0s', () => {
    expect(durationLabel(0)).toBe('0s');
  });
});
