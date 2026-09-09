import { describe, expect, it } from 'vitest';
import { useAssistantSeedStore } from './assistant-seed.js';

/**
 * The one piece of assistant state that crosses a navigation (this file's own
 * header). The property under test: `take()` is a read-and-clear in one call,
 * so a later, unrelated visit to `/assistant` never replays someone else's
 * setup flow.
 */

describe('useAssistantSeedStore', () => {
  it('starts with no seed', () => {
    expect(useAssistantSeedStore.getState().seed).toBeNull();
  });

  it('take() returns what setSeed() stored, and clears it', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    useAssistantSeedStore.getState().setSeed(messages);

    expect(useAssistantSeedStore.getState().seed).toEqual(messages);

    expect(useAssistantSeedStore.getState().take()).toEqual(messages);
    expect(useAssistantSeedStore.getState().seed).toBeNull();
    expect(useAssistantSeedStore.getState().take()).toBeNull();
  });
});
