import { describe, expect, it } from 'vitest';
import { parseInstant, parseNullableInstant, wire } from './wire.js';

describe('wire', () => {
  it('is a no-op at runtime — the value already crossed the wire as-is', () => {
    const value = { dueDate: '2026-03-01T09:00:00.000Z', title: 'x' };
    expect(wire(value)).toBe(value);
  });
});

describe('parseInstant', () => {
  it('parses a real ISO-8601 instant', () => {
    const parsed = parseInstant('2026-03-01T09:00:00.000Z');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe('2026-03-01T09:00:00.000Z');
  });

  it('throws rather than yielding an Invalid Date that silently breaks a sort', () => {
    expect(() => parseInstant('not a timestamp')).toThrow(TypeError);
  });
});

describe('parseNullableInstant', () => {
  it('passes null through without calling parseInstant', () => {
    expect(parseNullableInstant(null)).toBeNull();
  });

  it('parses a present value the same way parseInstant does', () => {
    expect(parseNullableInstant('2026-03-01T09:00:00.000Z')?.toISOString()).toBe(
      '2026-03-01T09:00:00.000Z',
    );
  });

  it('still throws on an unparseable present value', () => {
    expect(() => parseNullableInstant('not a timestamp')).toThrow(TypeError);
  });
});
