import { describe, expect, it } from 'vitest';
import {
  InboundRoute,
  escapeXml,
  menuChoiceToTwiml,
  outboundTwiml,
  routeToTwiml,
  type TwimlContext,
} from './twiml.js';

const AGENT = '0195ee40-0000-7000-8000-000000000001';
const SECOND = '0195ee40-0000-7000-8000-000000000002';

const context = (overrides: Partial<TwimlContext> = {}): TwimlContext => ({
  forwardingNumberFor: (userId) => (userId === AGENT ? '+14155550111' : undefined),
  recordingCallbackUrl: 'https://api.test/telephony/recording',
  menuActionUrl: 'https://api.test/telephony/menu',
  announcementRequired: true,
  record: false,
  ...overrides,
});

describe('escapeXml', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });

  it('escapes ampersands before the entities it introduces', () => {
    // `<` -> `&lt;` first would then have its own `&` re-escaped to `&amp;lt;`.
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml('<')).toBe('&lt;');
  });
});

describe('routeToTwiml', () => {
  it('escapes an admin-authored greeting rather than interpolating it', () => {
    /* The injection this prevents: a settings field lands inside markup that a
       third party executes with the org's money attached. */
    const route = InboundRoute.parse({ kind: 'say', text: '</Say><Dial>+19005550100</Dial>' });
    const xml = routeToTwiml(route, context());

    expect(xml).not.toContain('<Dial>');
    expect(xml).toContain('&lt;/Say&gt;');
  });

  it('dials a member with a verified forwarding number', () => {
    const route = InboundRoute.parse({ kind: 'dial_user', userId: AGENT });
    expect(routeToTwiml(route, context())).toContain('<Number>+14155550111</Number>');
  });

  it('does NOT dial when the member has no verified forwarding number', () => {
    /* Falling back to some other number would be this system placing a call to
       a destination nobody configured. */
    const route = InboundRoute.parse({ kind: 'dial_user', userId: SECOND });
    const xml = routeToTwiml(route, context());

    expect(xml).not.toContain('<Dial');
    expect(xml).toContain('<Hangup/>');
  });

  describe('hunt groups', () => {
    it('rings simultaneously inside one Dial', () => {
      const route = InboundRoute.parse({
        kind: 'hunt',
        userIds: [AGENT, SECOND],
        strategy: 'simultaneous',
        ringSeconds: 20,
      });
      const xml = routeToTwiml(route, context({ forwardingNumberFor: () => '+14155550111' }));

      expect(xml.match(/<Dial/g)).toHaveLength(1);
      expect(xml.match(/<Number>/g)).toHaveLength(2);
    });

    it('rings sequentially as consecutive Dial verbs', () => {
      const route = InboundRoute.parse({
        kind: 'hunt',
        userIds: [AGENT, SECOND],
        strategy: 'sequential',
        ringSeconds: 20,
      });
      const xml = routeToTwiml(route, context({ forwardingNumberFor: () => '+14155550111' }));

      expect(xml.match(/<Dial/g)).toHaveLength(2);
    });

    it('skips members with no forwarding number instead of dialling nothing', () => {
      const route = InboundRoute.parse({
        kind: 'hunt',
        userIds: [AGENT, SECOND],
        strategy: 'simultaneous',
        ringSeconds: 20,
      });
      const xml = routeToTwiml(route, context());
      expect(xml.match(/<Number>/g)).toHaveLength(1);
    });
  });

  describe('recording and the consent announcement (§3.5)', () => {
    it('emits NO record attribute when the call is not being recorded', () => {
      const route = InboundRoute.parse({ kind: 'dial_user', userId: AGENT });
      expect(routeToTwiml(route, context({ record: false }))).not.toContain('record=');
    });

    it('plays the announcement BEFORE any verb that can capture audio', () => {
      const route = InboundRoute.parse({ kind: 'dial_user', userId: AGENT });
      const xml = routeToTwiml(route, context({ record: true, announcementRequired: true }));

      const sayAt = xml.indexOf('<Say>');
      const dialAt = xml.indexOf('<Dial');
      expect(sayAt).toBeGreaterThan(-1);
      /* Ordering IS the control. A UI affordance a caller could skip is not a
         control; only markup the carrier executes in this order counts. */
      expect(sayAt).toBeLessThan(dialAt);
      expect(xml).toContain('may be recorded');
    });

    it('omits the announcement in a one-party jurisdiction', () => {
      const route = InboundRoute.parse({ kind: 'dial_user', userId: AGENT });
      const xml = routeToTwiml(route, context({ record: true, announcementRequired: false }));

      expect(xml).not.toContain('may be recorded');
      expect(xml).toContain('record=');
    });
  });

  describe('menus', () => {
    const menu = InboundRoute.parse({
      kind: 'menu',
      prompt: 'Press 1 for sales',
      choices: { '1': { kind: 'dial_user', userId: AGENT } },
      fallback: { kind: 'say', text: 'Goodbye' },
    });

    it('gathers one digit with a bounded timeout', () => {
      const xml = routeToTwiml(menu, context());
      expect(xml).toContain('numDigits="1"');
      // An IVR that waits forever holds a billable call open.
      expect(xml).toMatch(/timeout="\d+"/);
    });

    it('falls through to the fallback after the Gather', () => {
      expect(routeToTwiml(menu, context())).toContain('Goodbye');
    });

    it('routes a pressed digit to its destination', () => {
      expect(menuChoiceToTwiml(menu, '1', context())).toContain('<Number>+14155550111</Number>');
    });

    it('falls back on an unmapped digit rather than erroring', () => {
      /* A caller pressing 7 on a two-option menu is an ordinary mistake, and
         answering it with a 500 drops a live call. */
      expect(menuChoiceToTwiml(menu, '7', context())).toContain('Goodbye');
    });

    it('does not repeat the recording announcement on a menu selection', () => {
      const xml = menuChoiceToTwiml(
        menu,
        '1',
        context({ record: true, announcementRequired: true }),
      );
      expect(xml).not.toContain('may be recorded');
    });
  });

  describe('the config schema is closed', () => {
    it('rejects an unknown action kind', () => {
      // The config can only express destinations this system already knows
      // about — an admin cannot smuggle raw TwiML through it.
      expect(() =>
        InboundRoute.parse({ kind: 'raw_twiml', xml: '<Dial>+19005550100</Dial>' }),
      ).toThrow();
    });

    it('rejects unknown keys on a known action', () => {
      expect(() => InboundRoute.parse({ kind: 'say', text: 'hi', record: true })).toThrow();
    });

    it('bounds hunt group size and ring time', () => {
      expect(() =>
        InboundRoute.parse({
          kind: 'hunt',
          userIds: Array.from({ length: 50 }, () => AGENT),
          strategy: 'simultaneous',
          ringSeconds: 20,
        }),
      ).toThrow();
    });
  });
});

describe('outboundTwiml', () => {
  it('dials the customer with the org number as caller id', () => {
    const xml = outboundTwiml({
      to: '+14155550100',
      callerId: '+14155550199',
      context: context(),
    });

    expect(xml).toContain('callerId="+14155550199"');
    expect(xml).toContain('<Number>+14155550100</Number>');
  });

  it('announces before dialling when recording with consent required', () => {
    const xml = outboundTwiml({
      to: '+14155550100',
      callerId: '+14155550199',
      context: context({ record: true, announcementRequired: true }),
    });

    expect(xml.indexOf('<Say>')).toBeLessThan(xml.indexOf('<Dial'));
  });
});
