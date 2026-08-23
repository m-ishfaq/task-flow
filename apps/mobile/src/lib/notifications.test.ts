import { describe, expect, it } from 'vitest';
import { mobileRouteFor, notificationIcon } from './notifications.js';

describe('mobileRouteFor', () => {
  it('routes a card notification to the card screen when a board is named', () => {
    expect(
      mobileRouteFor({
        subjectType: 'card',
        subjectId: 'card-1',
        boardId: 'board-1',
        channelId: null,
      }),
    ).toBe('/card/card-1');
  });

  it('returns null for a Docs page notification — no Docs screen on native', () => {
    expect(
      mobileRouteFor({ subjectType: 'page', subjectId: 'page-1', boardId: null, channelId: null }),
    ).toBeNull();
  });

  it('returns null for a membership notification — no settings screen on native', () => {
    expect(
      mobileRouteFor({
        subjectType: 'membership',
        subjectId: 'member-1',
        boardId: null,
        channelId: null,
      }),
    ).toBeNull();
  });

  it('falls back to the channel route for a chat notification', () => {
    expect(
      mobileRouteFor({
        subjectType: 'message',
        subjectId: 'msg-1',
        boardId: null,
        channelId: 'channel-1',
      }),
    ).toBe('/channel/channel-1');
  });

  it('returns null when nothing routable is named', () => {
    expect(
      mobileRouteFor({ subjectType: 'card', subjectId: 'card-1', boardId: null, channelId: null }),
    ).toBeNull();
  });
});

describe('notificationIcon', () => {
  it('maps every named kind to its own glyph', () => {
    expect(notificationIcon('chat.mention')).toBe('@');
    expect(notificationIcon('card.comment_mention')).toBe('@');
    expect(notificationIcon('page.comment_mention')).toBe('@');
    expect(notificationIcon('chat.direct')).toBe('✉️');
    expect(notificationIcon('chat.thread_reply')).toBe('↩️');
    expect(notificationIcon('card.assigned')).toBe('📌');
    expect(notificationIcon('call.missed')).toBe('📞');
  });

  it('falls back to the bell for an unrecognized kind', () => {
    expect(notificationIcon('something.new')).toBe('🔔');
  });
});
