import { describe, expect, it } from 'vitest';
import { encodeReference, stripReferenceEmbeds } from './entity-reference.js';

const USER_ID = '01a06d4e-39fc-70cd-b999-005d0957482b';
const PROJECT_ID = '01a06d4e-39fc-706b-adfa-bf8a503c2089';

describe('encodeReference', () => {
  it('appends a {{type:id}} suffix to the label', () => {
    expect(encodeReference('Priya Nakamura', 'user', USER_ID)).toBe(
      `Priya Nakamura{{user:${USER_ID}}}`,
    );
  });
});

describe('stripReferenceEmbeds', () => {
  it('removes an embed, leaving only the label', () => {
    expect(stripReferenceEmbeds(encodeReference('Priya Nakamura', 'user', USER_ID))).toBe(
      'Priya Nakamura',
    );
  });

  it('removes multiple embeds from the same message', () => {
    const text =
      `assign it to ${encodeReference('Priya Nakamura', 'user', USER_ID)} ` +
      `in ${encodeReference('Website', 'project', PROJECT_ID)}`;
    expect(stripReferenceEmbeds(text)).toBe('assign it to Priya Nakamura in Website');
  });

  it('leaves ordinary text with no embed untouched', () => {
    expect(stripReferenceEmbeds('move WEB-709 to In Progress')).toBe('move WEB-709 to In Progress');
  });

  it('never strips a template-like string a person typed by hand', () => {
    const text = 'the template uses {{note}} and {{user:not-a-real-uuid}}';
    expect(stripReferenceEmbeds(text)).toBe(text);
  });
});
