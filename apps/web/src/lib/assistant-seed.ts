import { create } from 'zustand';
import type { ChatMessageWire } from '../features/ai/api.js';

/**
 * The one piece of assistant state that crosses a NAVIGATION rather than
 * living inside the chat page itself (`ui-store.ts`'s own rule: Zustand holds
 * only things with no server representation, and this has none — it is a
 * draft transcript, not a saved conversation).
 *
 * The §6 bootstrap dialog (`setup-dialog.tsx`) composes the assistant's first
 * exchange (its own opening turn plus the pending Docs page creations it
 * proposes) BEFORE navigating to `/assistant`, so the chat page can render
 * that exchange the instant it mounts rather than the visitor watching an
 * empty page send its own first message. Consumed exactly once —
 * `useAssistantSeed`'s `take()` returns the value and clears it in the same
 * call, so a later visit to `/assistant` (a manual link, the back button)
 * starts a genuinely empty conversation rather than replaying someone's setup
 * flow.
 */
interface AssistantSeedState {
  readonly seed: readonly ChatMessageWire[] | null;
  readonly setSeed: (messages: readonly ChatMessageWire[]) => void;
  /** Returns the seed and clears it — a read is also a consume. */
  readonly take: () => readonly ChatMessageWire[] | null;
}

export const useAssistantSeedStore = create<AssistantSeedState>((set, get) => ({
  seed: null,
  setSeed: (messages) => {
    set({ seed: messages });
  },
  take: () => {
    const current = get().seed;
    if (current !== null) set({ seed: null });
    return current;
  },
}));
