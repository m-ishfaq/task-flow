import { createClient } from './trpc-client.js';
import { authHeaders } from './session.js';

/**
 * The authenticated tRPC client — the only way this app talks to the server.
 *
 * There is no other transport. `fetch` against an API path anywhere in `src/`
 * would bypass the token attachment, the org header, and the typed contract that
 * guardrail 5 exists to provide, so it does not appear.
 *
 * Headers are resolved per request rather than captured once. That is what lets
 * `authHeaders()` refresh a spent token before the request goes out, and it is
 * why an org switch takes effect on the next query without rebuilding anything.
 */
export const api = createClient({ headers: authHeaders });

export { apiErrorOf, errorCodeOf, isUnauthenticated } from './trpc-client.js';
