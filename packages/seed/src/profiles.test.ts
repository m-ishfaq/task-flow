import { describe, expect, it } from 'vitest';
import { PROFILES, plannedMessageCount, type ChannelPlan } from './profiles.js';

/**
 * Profile invariants that a database CHECK would otherwise discover.
 *
 * Every case here mirrors a constraint in migration 0017. The point is where the
 * failure lands: a profile expressing a channel Postgres refuses fails halfway
 * through a seed run with an error naming an index, minutes after the mistake
 * and nowhere near the line that made it. These are the same rules, asked of the
 * plan.
 */

const ALL_CHANNELS: readonly (readonly [string, string, ChannelPlan])[] = Object.values(
  PROFILES,
).flatMap((profile) =>
  profile.orgs.flatMap((org) =>
    org.channels.map((channel) => [profile.name, org.slug, channel] as const),
  ),
);

describe('channel plans', () => {
  it('names every public and private channel, and no direct message', () => {
    /* `channels_name_matches_type` is one CHECK over both branches, so there is
       no state where `type` and `name` disagree — a named DM is exactly the row
       that would let a private conversation appear in a channel browser. */
    for (const [profile, org, channel] of ALL_CHANNELS) {
      const where = `${profile}/${org}`;
      if (channel.type === 'public' || channel.type === 'private') {
        expect(channel.name, where).not.toBeNull();
        expect((channel.name ?? '').trim().length, where).toBeGreaterThan(0);
        expect((channel.name ?? '').length, where).toBeLessThanOrEqual(80);
      } else {
        expect(channel.name, where).toBeNull();
      }
    }
  });

  it('gives a dm exactly two participants and a group_dm at least three', () => {
    for (const [profile, org, channel] of ALL_CHANNELS) {
      const where = `${profile}/${org}`;
      if (channel.type === 'dm') expect(channel.members, where).toBe(2);
      if (channel.type === 'group_dm') expect(channel.members, where).toBeGreaterThanOrEqual(3);
    }
  });

  it('never plans two live channels with the same name in one org', () => {
    // `channels_org_name_key` is unique on (org_id, lower(name)) for live named
    // channels. Two #general channels make every "which one did they mean"
    // conversation permanent.
    for (const profile of Object.values(PROFILES)) {
      for (const org of profile.orgs) {
        const live = org.channels
          .filter((channel) => channel.name !== null && channel.archived !== true)
          .map((channel) => (channel.name ?? '').toLowerCase());
        expect(new Set(live).size, `${profile.name}/${org.slug}`).toBe(live.length);
      }
    }
  });

  it('never asks for more members than its org has', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const org of profile.orgs) {
        for (const channel of org.channels) {
          expect(channel.members, `${profile.name}/${org.slug}`).toBeLessThanOrEqual(
            org.members.length,
          );
        }
      }
    }
  });
});

describe('the demo profile', () => {
  const demo = PROFILES['demo'];

  it('exists', () => {
    expect(demo).toBeDefined();
  });

  it('covers all four channel types', () => {
    const types = new Set(demo?.orgs.flatMap((org) => org.channels.map((c) => c.type)) ?? []);
    expect(types).toEqual(new Set(['public', 'private', 'dm', 'group_dm']));
  });

  it('includes an archived channel, an empty one, and a guest channel', () => {
    /* Each of these is a UI state a uniform generator almost never produces, and
       each is named explicitly in profiles.ts for that reason. A profile edit
       that quietly drops one would leave the surface it exercises untested with
       nothing failing. */
    const channels = demo?.orgs.flatMap((org) => org.channels) ?? [];
    expect(channels.some((channel) => channel.archived === true)).toBe(true);
    expect(channels.some((channel) => channel.messages === 0)).toBe(true);
    expect(channels.some((channel) => channel.withGuest === true)).toBe(true);
  });

  it('has a tenant with no direct messages at all', () => {
    // A DM needs two participants, so the single-member tenant is the only place
    // "you are the only person here" is reachable.
    const orgs = demo?.orgs ?? [];
    expect(orgs.some((org) => org.channels.every((channel) => channel.type !== 'dm'))).toBe(true);
  });

  it('plans a channel big enough for a three-digit unread badge', () => {
    const channels = demo?.orgs.flatMap((org) => org.channels) ?? [];
    expect(channels.some((channel) => channel.messages >= 200)).toBe(true);
  });
});

describe('plannedMessageCount', () => {
  it('sums the top-level messages of every channel in every org', () => {
    for (const profile of Object.values(PROFILES)) {
      const expected = profile.orgs.reduce(
        (total, org) => total + org.channels.reduce((sum, channel) => sum + channel.messages, 0),
        0,
      );
      expect(plannedMessageCount(profile)).toBe(expected);
    }
  });

  it('is a floor: every profile plans at least one message', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(plannedMessageCount(profile)).toBeGreaterThan(0);
    }
  });
});
