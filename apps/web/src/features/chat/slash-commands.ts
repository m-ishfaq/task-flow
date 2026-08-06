/**
 * Slash commands (Wave 3, ai/phase-5-chat.md §5).
 *
 * ## Why these are CLIENT-side and take no new API surface
 *
 * §5's own scope note: "likely thin given no automation-engine consumer exists
 * yet (Phase 10)". Every command below is a shortcut for something the UI
 * already does through an existing, already-authorized route — `/leave` calls
 * `channels.removeMember`, `/topic` calls `channels.update`. None of them is a
 * new capability, and none of them needs a new endpoint.
 *
 * That matters more than it sounds. A server-side `commands.run({ text })`
 * endpoint would be a route whose authorization depends on parsing a string —
 * one place where "what did the user ask for" and "what are they allowed to do"
 * are decided by the same regex. Keeping the parse in the client means each
 * command resolves to an ordinary tRPC call that enforces its own permission
 * exactly as it does when a button triggers it, and a command someone is not
 * allowed to run fails the same way the button would.
 *
 * ## A message that merely STARTS with a slash is not a command
 *
 * `/etc/passwd is broken` and `/2 of us are out today` are things people type.
 * A command matches only when the first word is a name in this table; anything
 * else is sent as an ordinary message, unmodified. Guessing wrong in the other
 * direction — swallowing a message because it looked command-shaped — loses
 * what somebody wrote, which is the worse failure.
 */

export interface SlashCommand {
  /** The word after the slash, lowercase. */
  readonly name: string;
  /** Shown in the autocomplete list. */
  readonly hint: string;
  readonly description: string;
  /** Whether the rest of the line is required. */
  readonly needsArgument: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'topic',
    hint: '/topic <text>',
    description: "Set the channel's topic",
    needsArgument: true,
  },
  {
    name: 'leave',
    hint: '/leave',
    description: 'Leave this channel',
    needsArgument: false,
  },
  {
    name: 'shrug',
    hint: '/shrug <message>',
    description: 'Append ¯\\_(ツ)_/¯',
    needsArgument: false,
  },
  {
    name: 'me',
    hint: '/me <action>',
    description: 'Post as an action',
    needsArgument: true,
  },
];

const BY_NAME = new Map(SLASH_COMMANDS.map((command) => [command.name, command]));

export type ParsedCommand =
  | { readonly kind: 'none' }
  | { readonly kind: 'command'; readonly command: SlashCommand; readonly argument: string }
  | { readonly kind: 'unknown'; readonly name: string };

/**
 * Interprets the first word of a message.
 *
 * `unknown` is distinct from `none` on purpose: `/topc oops` is almost
 * certainly a typo for `/topic`, and telling someone so is better than silently
 * posting it as a message they meant as a command. `none` means it never looked
 * like a command at all.
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  /* A second slash means a path, not a command — `//` and `/usr/bin` are not
     things anyone is invoking. */
  if (trimmed.startsWith('//')) return { kind: 'none' };

  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (match === null) return { kind: 'none' };

  const name = (match[1] ?? '').toLowerCase();
  const argument = (match[2] ?? '').trim();

  const command = BY_NAME.get(name);
  if (command === undefined) return { kind: 'unknown', name };

  return { kind: 'command', command, argument };
}

/** Commands whose names start with `prefix`, for the autocomplete popover. */
export function matchingCommands(prefix: string): readonly SlashCommand[] {
  const needle = prefix.replace(/^\//, '').toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * The text a command posts, when it posts anything.
 *
 * Returns null for commands that ACT rather than say something — `/topic` and
 * `/leave` change state and post nothing, and returning an empty string for
 * them would produce a message the server refuses as empty.
 */
export function messageTextFor(parsed: ParsedCommand): string | null {
  if (parsed.kind !== 'command') return null;

  switch (parsed.command.name) {
    case 'shrug':
      return `${parsed.argument} ¯\\_(ツ)_/¯`.trim();
    case 'me':
      return parsed.argument === '' ? null : `_${parsed.argument}_`;
    default:
      return null;
  }
}
