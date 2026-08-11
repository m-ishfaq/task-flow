import { createServer, type Server } from 'node:http';
import { isDatabaseHealthy } from '@taskflow/db';

/**
 * The worker's health endpoints.
 *
 * A background process with no listening socket is one an orchestrator cannot
 * tell apart from a hung one, so this exists purely to be probed. The two-tier
 * shape is `apps/api`'s and `apps/realtime`'s, verbatim, and the split matters
 * to a scheduler: `/health/live` never touches the database (did the process
 * start), `/health/ready` does (can it actually do its job). A worker that is up
 * but cannot reach Postgres should stop being considered healthy even though
 * restarting it would not help.
 *
 * Anything else gets a 404. This server carries no application surface at all —
 * the worker is reached through the queue, never over HTTP — and answering
 * anything friendlier would invite someone to add a route to it later.
 */
export function createHealthServer(): Server {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health/live') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (request.method === 'GET' && request.url === '/health/ready') {
      isDatabaseHealthy()
        .then((healthy) => {
          response
            .writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ status: healthy ? 'ready' : 'not-ready' }));
        })
        .catch(() => {
          /* A thrown health check is an unhealthy one. Reporting 503 rather
             than letting the rejection escape keeps a transient database blip
             from killing the process that is meant to survive it. */
          response
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ status: 'not-ready' }));
        });
      return;
    }

    response.writeHead(404).end();
  });
}
