import { describe, expect, it } from 'vitest';
import { mobilePathFor } from './notification-path.js';

/**
 * `mobilePathFor` lives in its own file specifically so it can be tested
 * with no Expo/React Native runtime — `push-notifications.ts`, which calls
 * it, imports `react-native` and `expo-constants`, both of which fail to
 * even PARSE under Vitest (Flow syntax in `react-native`'s own source; see
 * `notification-path.ts`'s own header). This translation table is worth
 * its own coverage precisely because a wrong regex here fails SILENTLY —
 * a mistranslated path just does not navigate, with nothing in the UI to
 * say why.
 */
describe('mobilePathFor', () => {
  it('translates a chat notification link to the channel screen', () => {
    expect(mobilePathFor('/chat?channel=abc123')).toBe('/channel/abc123');
  });

  it('translates a card notification link to the card screen, dropping the board id', () => {
    expect(mobilePathFor('/boards/board-1?card=card-2')).toBe('/card/card-2');
  });

  it('returns null for a Docs link — no Docs screen exists on native', () => {
    expect(mobilePathFor('/docs?page=xyz')).toBeNull();
  });

  it('returns null for a settings/membership link — no mobile equivalent', () => {
    expect(mobilePathFor('/settings')).toBeNull();
  });

  it('returns null for an unrecognized shape rather than guessing', () => {
    expect(mobilePathFor('/something/else')).toBeNull();
    expect(mobilePathFor('')).toBeNull();
  });
});
