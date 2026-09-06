/**
 * The "this org was just created" signal (ai/phase-15-ai-copilot-and-
 * permissions.md §6) — the UI trigger the phase's own status header says was
 * the only missing piece, `docs.create_page` already existing as the tool the
 * flow calls.
 *
 * `sessionStorage`, not a server column. §6 is an OFFER, not a state machine:
 * there is nothing here worth a migration, an org has no "has this been
 * offered" field to add, and a tab closed mid-flow should not leave a fact
 * behind that outlives it. A flag scoped to the browser tab that created the
 * org is exactly the right lifetime — it answers "does the NEXT page load in
 * THIS tab belong to a fresh org" and nothing more durable than that.
 */

const PREFIX = 'taskflow.bootstrap.';

/** Marks an org as freshly created, for the next page load in this tab. */
export function markOrgForBootstrap(orgId: string): void {
  try {
    window.sessionStorage.setItem(`${PREFIX}${orgId}`, '1');
  } catch {
    // Private browsing, storage disabled, or a full quota — the offer simply
    // does not appear. Losing a one-time onboarding prompt is not worth
    // surfacing an error for.
  }
}

/**
 * Reads and clears the flag for one org in the same call — a read IS a
 * consume, so returning to `/projects` (a refresh, a bookmark) after seeing
 * the offer once never shows it again for this org in this tab.
 */
export function consumeBootstrapFlag(orgId: string): boolean {
  try {
    const key = `${PREFIX}${orgId}`;
    const flagged = window.sessionStorage.getItem(key) === '1';
    if (flagged) window.sessionStorage.removeItem(key);
    return flagged;
  } catch {
    return false;
  }
}
