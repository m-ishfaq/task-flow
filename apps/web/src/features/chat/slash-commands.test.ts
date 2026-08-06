import { describe, expect, it } from 'vitest';
import { matchingCommands, messageTextFor, parseCommand } from './slash-commands.js';

/**
 * Slash command parsing (Wave 3).
 *
 * The interesting half is everything that must NOT be treated as a command.
 * Swallowing a message because it looked command-shaped loses what somebody
 * wrote, and does it silently — the composer clears, nothing posts, and there
 * is no error to report. Half the cases here are ordinary sentences that happen
 * to begin with a slash.
 */

describe('parseCommand — what is a command', () => {
  it('recognizes a bare command', () => {
    const parsed = parseCommand('/leave');
    expect(parsed.kind).toBe('command');
    expect(parsed.kind === 'command' && parsed.command.name).toBe('leave');
  });

  it('recognizes a command with an argument', () => {
    const parsed = parseCommand('/topic Sprint planning');
    expect(parsed.kind === 'command' && parsed.argument).toBe('Sprint planning');
  });

  it('is case-insensitive on the name but not the argument', () => {
    const parsed = parseCommand('/TOPIC Keep This Case');
    expect(parsed.kind === 'command' && parsed.command.name).toBe('topic');
    expect(parsed.kind === 'command' && parsed.argument).toBe('Keep This Case');
  });

  it('tolerates leading whitespace', () => {
    expect(parseCommand('   /leave').kind).toBe('command');
  });
});

describe('parseCommand — what is NOT a command', () => {
  it('leaves an ordinary message alone', () => {
    expect(parseCommand('hello').kind).toBe('none');
    expect(parseCommand('').kind).toBe('none');
  });

  it('leaves a path alone', () => {
    /* `/etc/passwd is broken` is a sentence somebody types. Treating it as an
       unknown command would be merely annoying; treating it as a command and
       swallowing it would lose the message. */
    expect(parseCommand('//mnt/share is down').kind).toBe('none');
  });

  it('leaves a slash followed by a digit alone', () => {
    // "/2 of us are out today". The name must start with a letter.
    expect(parseCommand('/2 of us are out today').kind).toBe('none');
  });

  it('leaves a bare slash alone', () => {
    expect(parseCommand('/').kind).toBe('none');
    expect(parseCommand('/ ').kind).toBe('none');
  });

  it('reports an unrecognized name rather than posting it silently', () => {
    /* `unknown` is deliberately distinct from `none`: `/topc oops` is almost
       certainly a typo for `/topic`, and saying so beats posting it as a
       message the person meant as a command. */
    const parsed = parseCommand('/topc oops');
    expect(parsed.kind).toBe('unknown');
    expect(parsed.kind === 'unknown' && parsed.name).toBe('topc');
  });
});

describe('messageTextFor', () => {
  it('posts nothing for commands that act', () => {
    // `/topic` and `/leave` change state. Returning '' would produce a message
    // the server refuses as empty.
    expect(messageTextFor(parseCommand('/topic Anything'))).toBeNull();
    expect(messageTextFor(parseCommand('/leave'))).toBeNull();
  });

  it('appends the shrug, with or without text', () => {
    expect(messageTextFor(parseCommand('/shrug who knows'))).toBe('who knows ¯\\_(ツ)_/¯');
    expect(messageTextFor(parseCommand('/shrug'))).toBe('¯\\_(ツ)_/¯');
  });

  it('italicizes an action and refuses an empty one', () => {
    expect(messageTextFor(parseCommand('/me is deploying'))).toBe('_is deploying_');
    expect(messageTextFor(parseCommand('/me'))).toBeNull();
  });

  it('returns null for anything that is not a command', () => {
    expect(messageTextFor(parseCommand('hello'))).toBeNull();
    expect(messageTextFor(parseCommand('/nope'))).toBeNull();
  });
});

describe('matchingCommands', () => {
  it('filters by prefix, with or without the slash', () => {
    expect(matchingCommands('/t').map((command) => command.name)).toEqual(['topic']);
    expect(matchingCommands('t').map((command) => command.name)).toEqual(['topic']);
  });

  it('returns everything for a bare slash', () => {
    expect(matchingCommands('/').length).toBeGreaterThan(1);
  });

  it('returns nothing for a prefix that matches none', () => {
    expect(matchingCommands('/zzz')).toEqual([]);
  });
});
