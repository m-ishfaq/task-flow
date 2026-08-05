import type { Message } from './api.js';

/** Consecutive messages, same rules a real chat product uses to feel like a conversation. */
export interface MessageGroup {
  readonly authorId: string | null;
  readonly messages: readonly Message[];
}

/** Two messages fall in one group only if they are close enough that repeating the header would be noise. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Collapses consecutive same-author messages into one visual group — the
 * single thing that most makes a message list read as a conversation rather
 * than a log of identical boxes, each repeating an avatar and a name that
 * did not change since the line above it.
 *
 * Grouped by AUTHOR ID, not by author label: two different people can
 * resolve to the same fallback label (`personOf` falls back to the raw id
 * for someone no longer in the org — `use-members.ts`'s own note), and
 * grouping by the resolved string would silently merge their messages under
 * one header.
 *
 * The window resets from each message to the PREVIOUS ONE, not from the
 * group's first message — a burst of messages five minutes apart, each
 * within the window of its immediate predecessor, reads as one continuous
 * exchange, and splitting it every five minutes from an arbitrary starting
 * point would not match how the conversation actually happened.
 */
export function groupMessages(messages: readonly Message[]): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const current = groups[groups.length - 1];
    const previous = current?.messages[current.messages.length - 1];

    const sameAuthor = current?.authorId === message.authorId;
    const withinWindow =
      previous !== undefined &&
      Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <
        GROUP_WINDOW_MS;

    if (current !== undefined && sameAuthor && withinWindow) {
      groups[groups.length - 1] = { ...current, messages: [...current.messages, message] };
    } else {
      groups.push({ authorId: message.authorId, messages: [message] });
    }
  }

  return groups;
}
