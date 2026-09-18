import { create } from 'zustand';

/**
 * Global maintenance-mode state, driven by 503 responses from the API.
 *
 * When the backend's onRequest hook blocks a request with status 'maintenance',
 * this store is updated so a banner can render app-wide. The banner is dismissed
 * per-session (localStorage) until a NEW maintenance message arrives — the same
 * "dismiss stays dismissed until the message changes" pattern a premium alert uses.
 */

const DISMISS_KEY = 'tf_maintenance_dismissed_msg';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(msg: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, msg);
  } catch {
    /* Storage full or private-browsing — dismiss locally only. */
  }
}

interface MaintenanceState {
  /** Whether the API is currently in maintenance mode. */
  readonly active: boolean;
  /** The operator-supplied maintenance message. */
  readonly message: string;
  /**
   * Whether the user dismissed this banner.
   *
   * Resets when the maintenance MESSAGE changes (a new message means a new
   * situation the user should see), or on page reload if the message is the
   * same as what was dismissed.
   */
  readonly dismissed: boolean;

  /** Called by the cache-error handler when a 503 maintenance response arrives. */
  readonly activate: (message: string) => void;
  /** Called when the user clicks the close button. */
  readonly dismiss: () => void;
}

export const useMaintenanceStore = create<MaintenanceState>((set) => ({
  active: false,
  message: '',
  dismissed: readDismissed() !== null,

  activate(message) {
    const prev = readDismissed();
    /* A new message (or first activation) clears the dismissed flag so the
       banner reappears — the user needs to see a changed situation. */
    if (prev !== message) {
      set({ active: true, message, dismissed: false });
    } else {
      set({ active: true, message });
    }
  },

  dismiss() {
    const { message } = useMaintenanceStore.getState();
    writeDismissed(message);
    set({ dismissed: true });
  },
}));
