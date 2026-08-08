/* TaskFlow push service worker (Phase 9 Wave 2, ai/phase-9-notifications.md §3.7).
 *
 * Served VERBATIM from /sw.js — a static asset with no build step. Keep it
 * dependency-free: a service worker that must `importScripts` a bundled chunk
 * fails to install on a flaky network, and a failed install silently kills
 * push for everyone until the file changes again.
 *
 * It does exactly two things: turn a `push` event into a notification, and
 * turn a click on one into the right page. Both are payload-driven — every
 * message the relay encrypts is `{ title, body, path }` (see
 * apps/api/src/platform/notification-push.ts), so this file has no idea what
 * a notification is about, which is what keeps it from going stale when a new
 * notification kind ships.
 */

self.addEventListener('install', () => {
  // Take over without waiting for the next navigation/reload, so a user who
  // just enabled push starts receiving it on this tab immediately rather than
  // on their next visit.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  // A malformed payload is a bug in our own relay, not something to show the
  // user; refuse it rather than rendering "undefined".
  if (payload === null || typeof payload.title !== 'string' || payload.title === '') {
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === 'string' ? payload.body : undefined,
      data: { path: typeof payload.path === 'string' ? payload.path : null },
      // `tag` coalesces a burst of notifications from the same subject into
      // one slot in the tray rather than a wall of them (a board's dozen
      // assignees arriving at once).
      tag: payload.path ?? 'taskflow',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const path = event.notification.data?.path;
  if (typeof path !== 'string') {
    return;
  }

  event.waitUntil(
    (async () => {
      const target = new URL(path, self.location.origin);

      // Focus an existing window on this origin rather than stacking a new
      // one — the common case is the app being open in the background.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin === target.origin) {
          await client.navigate(target.pathname + target.search);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
