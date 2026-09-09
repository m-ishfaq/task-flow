/**
 * Carrying a destination across the multi-hop, possibly-multi-tab signup
 * flow — register, then a SEPARATE verification email, then sign in.
 *
 * `router.tsx`'s `next` search param already carries a destination through
 * `/login`, but registration breaks that chain: `auth.register` answers
 * "check your email" with no session and no redirect, and the verification
 * link that follows is clicked from wherever the email client opens it —
 * often a NEW TAB of the same browser, sometimes days later. A destination
 * held only in this tab's own React state or a URL param on `/register`
 * would already be gone by the time that link is clicked.
 *
 * `localStorage` survives exactly that: it is shared across every tab of
 * the same browser and outlives a closed tab, which is what `session.ts`
 * itself avoids for the ACCESS TOKEN precisely because an XSS can read it.
 * The trade is accepted here for a different reason than it is refused
 * there — this holds a single-use, short-lived, narrowly-scoped invitation
 * token (join one org, as one role, for one email), not a bearer credential
 * that reaches every authenticated route. The blast radius of an XSS
 * reading it is "redeem one pending invite early," not "act as this user."
 *
 * Does NOT cover verifying on a different device than the one used to
 * register — a phone's inbox opening a link nothing on that phone's
 * browser ever stored. That is a real, known limitation of any
 * localStorage-based approach, not something worth hiding: closing it
 * would mean encoding the destination into the verification email's own
 * link, a change to `apps/api/src/identity`'s mail pipeline this fix does
 * not need for the common case (verifying in the same browser) to work.
 */

const PENDING_NEXT_KEY = 'taskflow:pending-next';

export function storePendingNext(next: string): void {
  try {
    window.localStorage.setItem(PENDING_NEXT_KEY, next);
  } catch {
    // Private browsing and blocked storage both throw here — the flow
    // still works, it just falls back to the plain post-verification
    // "sign in" link with no remembered destination.
  }
}

/**
 * `peekPendingNext`/`clearPendingNext` are deliberately TWO functions, not
 * one read-and-clear — the identical split `assistant-seed.ts`'s own
 * `useAssistantSeedStore` makes, for the identical reason. React's
 * StrictMode double-invokes a component's render (and a lazy `useState`
 * initializer with it) in development; a single "read and consume"
 * function called from an initializer would clear `localStorage` on the
 * FIRST throwaway invocation and hand the second one `null`, degrading a
 * feature that works in production into one that silently drops the
 * destination every time in dev. `VerifyEmailPage` peeks in its lazy
 * `useState` initializer (safe to call twice — no side effect) and clears
 * from an effect keyed on `verify.isSuccess` (idempotent to run twice —
 * `removeItem` on an absent key is a no-op).
 */
export function peekPendingNext(): string | null {
  try {
    return window.localStorage.getItem(PENDING_NEXT_KEY);
  } catch {
    return null;
  }
}

export function clearPendingNext(): void {
  try {
    window.localStorage.removeItem(PENDING_NEXT_KEY);
  } catch {
    // Nothing to clean up if storage never worked in the first place.
  }
}

/**
 * Pulls an invitation token out of a `next` path, when that path is the
 * `/invite/accept` route's own — used to preview an invitation (org name,
 * invited email) from `/login` and `/register` before anyone is signed in.
 *
 * `next` is already validated by `router.tsx`'s own search schema to start
 * with a single `/` and never `//`, so parsing it as a relative reference
 * against a placeholder base is safe here — this is ordinary path parsing,
 * not the "is this a safe absolute URL" check `markdown-lite.tsx`'s
 * `isSafeUrl` makes for arbitrary, unvalidated input.
 */
export function inviteTokenFromNext(next: string | undefined): string | undefined {
  if (next === undefined) return undefined;

  try {
    const url = new URL(next, 'https://placeholder.invalid');
    if (url.pathname !== '/invite/accept') return undefined;
    const token = url.searchParams.get('token');
    return token === null || token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}
