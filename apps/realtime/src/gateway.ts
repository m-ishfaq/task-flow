import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { createRealtimeAdapterPool, type OutboxRow } from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { clientAddress, HandshakeError, verifyHandshake } from './auth.js';
import { allowedOrigins, type Env } from './config/env.js';
import { assertRoomTableIsSafe, roomBoardIdOf, roomChannelIdOf } from './event-rooms.js';
import { broadcastPresence } from './presence.js';
import { FixedWindowLimiter } from './rate-limit.js';
import { authorizeChannelJoin, authorizeJoin } from './rooms.js';
import { applyChatRevocation, applyRevocation, revocationOf } from './revocation.js';
import { startRealtimeRelay, type RelayHandle } from './relay.js';
import type { ChatNamespace, ChatSocket, GatewayServer, GatewaySocket } from './socket-data.js';
import {
  boardRoom,
  channelRoom,
  ChannelJoinRequestSchema,
  ChannelLeaveRequestSchema,
  CHAT_NAMESPACE,
  JoinRequestSchema,
  LeaveRequestSchema,
  TypingRequestSchema,
  type JoinAck,
} from './wire.js';

/**
 * The Socket.io gateway (ai/phase-4-realtime.md §3, §5 Wave 1).
 *
 * ## Sockets broadcast; they never write
 *
 * CLAUDE.md rule 8, and Wave 1's acceptance depends on it staying true. There is
 * no handler here that mutates anything — the only client-to-server messages are
 * join and leave, which change this socket's own subscription and nothing in the
 * database. The temptation this phase invites is a client emitting an event the
 * gateway relays straight to other clients as an optimization; that is a second
 * write path, bypassing validation, authorization, audit and the outbox, and
 * PLAN.md §9 names it as the single most common source of subtle inconsistency
 * in systems like this.
 */

export interface Gateway {
  readonly io: GatewayServer;
  readonly http: HttpServer;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

export interface BuildGatewayOptions {
  readonly env: Env;
  readonly logger: Logger;
}

export function buildGateway(options: BuildGatewayOptions): Gateway {
  const { env, logger } = options;

  /* Boot-time, before a connection is accepted: a room table that ever maps an
     attachment event would hand a presigned download URL to everyone in the
     room. Failing here means failing in CI and on every developer's machine,
     rather than in production on a real attachment. */
  assertRoomTableIsSafe();

  const origins = allowedOrigins(env);
  const jwtSecret = Buffer.from(env.JWT_SECRET, 'base64');

  const http = createServer((_request, response) => {
    /* Health only. This server exists to carry WebSockets; anything else
       reaching it is a misrouted request, and answering 404 rather than
       something friendlier keeps it from looking like an API. */
    response.writeHead(404).end();
  });

  const io: GatewayServer = new Server(http, {
    /* Socket.io's own CORS, in addition to the origin check in the handshake.
       Belt and braces on purpose: this one governs the HTTP polling transport's
       preflight, the handshake check governs the upgraded connection, and they
       fail at different points. Neither is sufficient alone. */
    cors: { origin: [...origins], credentials: true },
    /* No `serveClient`: the browser bundle ships from apps/web, and serving a
       second copy from here would be a script on a different origin doing the
       same job. */
    serveClient: false,
  });

  /* Wired at single-instance scale on purpose (§5). The adapter is what makes a
     broadcast reach a client connected to a DIFFERENT instance; retrofitting it
     once two are already behind a load balancer means discovering the need
     through users who see half a board update. The pool comes from
     @taskflow/db — the gateway never constructs a database connection itself
     (guardrail 2). */
  io.adapter(createAdapter(createRealtimeAdapterPool(), { tableName: 'socket_io_attachments' }));

  /* -------------------------------------------------------------------- *
   * Rate limits (§6.5, §7.5)
   * -------------------------------------------------------------------- */
  const connectionsPerAddress = new FixedWindowLimiter(
    env.REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE,
  );
  const joinsPerSocket = new FixedWindowLimiter(env.REALTIME_MAX_JOINS_PER_MINUTE);
  const refusedJoinsPerSocket = new FixedWindowLimiter(env.REALTIME_MAX_REFUSED_JOINS_PER_MINUTE);

  /* Address windows are keyed by remote address and would otherwise grow
     without bound — slowly, which is why it would be found in production rather
     than in a test. Per-socket windows are dropped on disconnect instead. */
  const sweeper = setInterval(() => {
    connectionsPerAddress.sweep();
  }, 60_000);
  sweeper.unref();

  /* -------------------------------------------------------------------- *
   * The handshake (§3.2, §3.8)
   *
   * ONE middleware, applied to both namespaces (ai/phase-5-chat.md §3.2). Chat
   * adds a namespace and room names; it adds no authentication code. Writing a
   * second copy of this for `/chat` is the specific thing §3.2 rules out — two
   * handshakes drift, and the one that drifts is the one guarding direct
   * messages.
   *
   * Typed against the board socket's shape and reused for the chat socket: the
   * two differ only in their event maps, and this function touches neither. It
   * reads `socket.request` and writes `socket.data`, both of which are identical
   * across namespaces.
   * -------------------------------------------------------------------- */
  const authenticate = (
    socket: GatewaySocket | ChatSocket,
    next: (error?: Error) => void,
  ): void => {
    void (async () => {
      const address = clientAddress(socket.request, env.REALTIME_TRUST_PROXY);

      /* Counted BEFORE the token is verified. A limiter that only counted
         authenticated connections would leave the unauthenticated flood — the
         cheaper attack — completely unbounded. */
      if (!connectionsPerAddress.hit(address)) {
        logger.warn({ address }, 'handshake refused: too many connections from this address');
        next(new HandshakeError('rate_limited'));
        return;
      }

      try {
        const identity = await verifyHandshake(socket, { jwtSecret, allowedOrigins: origins });

        /* THE one assignment of a socket's identity (§3.7). Everything else in
           this file reads `socket.data.identity`; nothing anywhere writes it. */
        const data = socket.data;
        data.identity = { userId: identity.userId, sessionId: identity.sessionId };
        Object.assign(data, { rooms: new Map(), address });

        next();
      } catch (error) {
        /* Observable, even though sockets never write to the audit log (§3.8).
           A refusal is not a mutation, so guardrail 11 does not apply — but "not
           an audit event" and "invisible to anyone" are different requirements,
           and the same address refused across a burst of attempts is exactly
           what probing looks like. */
        const refusal = error instanceof HandshakeError ? error.refusal : 'invalid_token';
        logger.warn({ address, refusal }, 'handshake refused');
        next(error instanceof HandshakeError ? error : new HandshakeError('invalid_token'));
      }
    })();
  };

  io.use(authenticate);

  const chat: ChatNamespace = io.of(CHAT_NAMESPACE);
  chat.use(authenticate);

  /* -------------------------------------------------------------------- *
   * Connection lifecycle
   * -------------------------------------------------------------------- */
  io.on('connection', (socket: GatewaySocket) => {
    const { userId } = socket.data.identity;
    logger.debug({ userId }, 'socket connected');

    /* The client learns the reauth lead time from the server rather than
       hardcoding it (§7.1). Today it comes from this process's environment; when
       a platform-settings surface exists (§7.6) it comes from there and the
       browser does not change. */
    socket.emit('ready', { reauthLeadSeconds: env.REALTIME_REAUTH_LEAD_SECONDS });

    socket.on('board:join', (request: unknown, ack?: (result: JoinAck) => void) => {
      void (async () => {
        const respond = (result: JoinAck): void => ack?.(result);

        if (!joinsPerSocket.hit(socket.id)) {
          logger.warn({ userId }, 'join refused: too many joins on this socket');
          respond({ ok: false, reason: 'rate_limited' });
          return;
        }

        const parsed = JoinRequestSchema.safeParse(request);
        if (!parsed.success) {
          /* A malformed join counts as a refusal. It is the shape an
             enumeration script produces when it is iterating something that is
             not a valid id, and excusing it would leave that loop unbounded. */
          countRefusal(socket, 'invalid');
          respond({ ok: false, reason: 'invalid' });
          return;
        }

        const { orgId, boardId } = parsed.data;

        /* userId comes from socket.data — NEVER from `parsed.data`, which has no
           field for it and must never gain one (§3.7). */
        const outcome = await authorizeJoin(userId, orgId, boardId);

        if (!outcome.allowed) {
          logger.warn(
            { userId, orgId, boardId, reason: outcome.reason },
            'join refused by authorization',
          );
          countRefusal(socket, 'denied');
          /* One reason for every refusal. "Not a member", "no such board" and
             "denied" must be indistinguishable to the caller, for the same
             reason `enforce()` answers 404 rather than 403 on an invisible
             resource: a refusal that distinguishes them is an oracle for which
             board ids exist. */
          respond({ ok: false, reason: 'denied' });
          return;
        }

        await socket.join(boardRoom(boardId));
        socket.data.rooms.set(boardId, orgId);
        logger.debug({ userId, boardId }, 'socket joined room');
        respond({ ok: true });

        // After the join actually took effect, not before — a client reading
        // its own ack alongside the first presence broadcast must find itself
        // already in the list (§9, Wave 2).
        void broadcastPresence(io, boardId);
      })();
    });

    socket.on('board:leave', (request: unknown) => {
      const parsed = LeaveRequestSchema.safeParse(request);
      if (!parsed.success) return;

      const { boardId } = parsed.data;
      socket.data.rooms.delete(boardId);

      void (async () => {
        // `leave()` is typed `Promise<void> | void` — the adapter decides
        // which, so this always awaits rather than assuming either.
        await socket.leave(boardRoom(boardId));
        await broadcastPresence(io, boardId);
      })();
    });

    socket.on('disconnect', () => {
      joinsPerSocket.forget(socket.id);
      refusedJoinsPerSocket.forget(socket.id);
      logger.debug({ userId }, 'socket disconnected');

      /* Socket.io has already removed this socket from every room by the time
         this fires — `socket.data.rooms` (this module's own tracking, not
         Socket.io's internal set) is what still remembers which boards to
         tell. One broadcast per board this socket had open, so anyone left
         watching sees the departure. */
      for (const boardId of socket.data.rooms.keys()) {
        void broadcastPresence(io, boardId);
      }
    });
  });

  /* -------------------------------------------------------------------- *
   * The /chat namespace (ai/phase-5-chat.md §3.1, §3.2, §3.3)
   *
   * Structurally the board handler with a different room name and a different
   * `can()` question. It is written out rather than factored into a generic
   * "join a room of kind K" helper on purpose: the two differ in the one place
   * that matters — which authorization function runs — and a generic version
   * would take that as a parameter, which is exactly the shape where passing
   * the wrong one compiles.
   *
   * There is no presence broadcast here. Presence is a Wave 2 surface for chat
   * (§5), and the board version is not reused blindly: "who has this board open"
   * is a useful signal on a kanban board and a very different thing to publish
   * about a direct message.
   * -------------------------------------------------------------------- */
  chat.on('connection', (socket: ChatSocket) => {
    const { userId } = socket.data.identity;
    logger.debug({ userId }, 'chat socket connected');

    socket.emit('ready', { reauthLeadSeconds: env.REALTIME_REAUTH_LEAD_SECONDS });

    socket.on('channel:join', (request: unknown, ack?: (result: JoinAck) => void) => {
      void (async () => {
        const respond = (result: JoinAck): void => ack?.(result);

        if (!joinsPerSocket.hit(socket.id)) {
          logger.warn({ userId }, 'channel join refused: too many joins on this socket');
          respond({ ok: false, reason: 'rate_limited' });
          return;
        }

        const parsed = ChannelJoinRequestSchema.safeParse(request);
        if (!parsed.success) {
          countChatRefusal(socket, 'invalid');
          respond({ ok: false, reason: 'invalid' });
          return;
        }

        const { orgId, channelId } = parsed.data;

        /* userId from socket.data — NEVER from `parsed.data`, which has no field
           for it and must never gain one (§3.7). On this namespace that rule is
           load-bearing in the most direct way available: the room being asked
           for may be a two-person conversation. */
        const outcome = await authorizeChannelJoin(userId, orgId, channelId);

        if (!outcome.allowed) {
          logger.warn(
            { userId, orgId, channelId, reason: outcome.reason },
            'channel join refused by authorization',
          );
          countChatRefusal(socket, 'denied');
          /* One reason for every refusal. "Not a member", "no such channel" and
             "denied" are indistinguishable to the caller — a refusal that told
             them apart would let someone enumerate which private channels
             exist, and confirming the existence of a DM is itself a disclosure
             about two people. */
          respond({ ok: false, reason: 'denied' });
          return;
        }

        await socket.join(channelRoom(channelId));
        socket.data.rooms.set(channelId, orgId);
        logger.debug({ userId, channelId }, 'socket joined channel room');
        respond({ ok: true });
      })();
    });

    socket.on('channel:leave', (request: unknown) => {
      const parsed = ChannelLeaveRequestSchema.safeParse(request);
      if (!parsed.success) return;

      const { channelId } = parsed.data;
      socket.data.rooms.delete(channelId);
      void socket.leave(channelRoom(channelId));
    });

    /* Typing indicators (ai/phase-5-chat.md §5) — relayed in-process, never a
       domain event (see `events.ts`'s header on why). `socket.to(...)` rather
       than `chat.to(...)` so the sender never receives its own typing state
       back, and only sockets that already hold the room — meaning they passed
       `authorizeChannelJoin` — ever receive it. A channel named here that this
       socket never joined is silently ignored rather than relayed: there is no
       ack on this event for a refusal to answer through. */
    const relayTyping = (request: unknown, typing: boolean): void => {
      const parsed = TypingRequestSchema.safeParse(request);
      if (!parsed.success) return;

      const { channelId } = parsed.data;
      if (!socket.data.rooms.has(channelId)) return;

      socket.to(channelRoom(channelId)).emit('typing', { channelId, userId, typing });
    };

    socket.on('typing:start', (request: unknown) => {
      relayTyping(request, true);
    });
    socket.on('typing:stop', (request: unknown) => {
      relayTyping(request, false);
    });

    socket.on('disconnect', () => {
      joinsPerSocket.forget(socket.id);
      refusedJoinsPerSocket.forget(socket.id);
      logger.debug({ userId }, 'chat socket disconnected');
    });
  });

  /** The chat namespace's copy of `countRefusal` — same reasoning, same limits. */
  function countChatRefusal(socket: ChatSocket, kind: string): void {
    if (refusedJoinsPerSocket.hit(socket.id)) return;

    logger.warn(
      { userId: socket.data.identity.userId, address: socket.data.address, kind },
      'disconnecting chat socket: sustained refused joins look like room enumeration',
    );
    socket.disconnect(true);
  }

  /**
   * Counts a refused join and disconnects a socket that keeps refusing (§7.5).
   *
   * A legitimate client's joins essentially never fail — it asks only for boards
   * the user just navigated to. So a run of refusals is not a user having a bad
   * day, it is someone finding out which board ids exist, and the refusals are
   * the signal rather than the noise.
   */
  function countRefusal(socket: GatewaySocket, kind: string): void {
    if (refusedJoinsPerSocket.hit(socket.id)) return;

    logger.warn(
      { userId: socket.data.identity.userId, address: socket.data.address, kind },
      'disconnecting socket: sustained refused joins look like room enumeration',
    );
    socket.disconnect(true);
  }

  /* -------------------------------------------------------------------- *
   * Broadcasting (§3.4, §3.5, §3.6)
   * -------------------------------------------------------------------- */

  /* Applied on every instance, not only the one whose relay claimed the event —
     the relay claims disjoint batches, so the claiming instance is almost never
     the one holding the affected socket. */
  io.on('revocation', (message) => {
    void applyRevocation(io, message, logger);
    /* The chat namespace holds its own sockets with their own room sets, so a
       revocation that only swept the default namespace would leave a removed
       member subscribed to the channel they were just removed from — the exact
       failure §3.3 names, on the surface where it matters most. */
    void applyChatRevocation(chat, message, logger);
  });

  const dispatch = async (row: OutboxRow): Promise<void> => {
    const revocation = revocationOf(row);
    if (revocation !== null) {
      io.serverSideEmit('revocation', revocation);
      await applyRevocation(io, revocation, logger);
      await applyChatRevocation(chat, revocation, logger);
      /* Falls through deliberately: a revocation event may ALSO have a room
         mapping in a later wave, and returning early here would make adding one
         silently do nothing. */
    }

    const channelId = roomChannelIdOf(row.name, row.payload);
    if (channelId !== null) {
      chat.to(channelRoom(channelId)).emit('broadcast', {
        name: row.name,
        version: row.version,
        orgId: row.orgId,
        channelId,
        actorId: row.actorId,
        mutationId: row.requestId,
        occurredAt: row.occurredAt.toISOString(),
        payload: row.payload,
      });
    }

    const boardId = roomBoardIdOf(row.name, row.payload);
    if (boardId === null) return;

    io.to(boardRoom(boardId)).emit('broadcast', {
      name: row.name,
      version: row.version,
      orgId: row.orgId,
      boardId,
      actorId: row.actorId,
      /* The originating request's id, carried through rather than minted here
         (§3.6) — a client that just performed this mutation optimistically
         already has the state and drops its own echo instead of re-applying it
         and flickering. */
      mutationId: row.requestId,
      /* A STRING on the wire, and typed as one (§6.3). `occurredAt` is a Date in
         this process and will be JSON-stringified on the way out; claiming
         otherwise in the type is the same lie `lib/wire.ts` exists to stop the
         compiler agreeing with. */
      occurredAt: row.occurredAt.toISOString(),
      payload: row.payload,
    });
  };

  let relay: RelayHandle | undefined;

  return {
    io,
    http,
    listen: async () => {
      relay = startRealtimeRelay({
        logger,
        dispatch,
        pollIntervalMs: env.REALTIME_POLL_INTERVAL_MS,
      });

      await new Promise<void>((resolve) => {
        http.listen(env.REALTIME_PORT, env.REALTIME_HOST, resolve);
      });
    },
    close: async () => {
      clearInterval(sweeper);
      /* Relay first: stopping it before the sockets close means an in-flight
         drain finishes against a live server rather than broadcasting into a
         closing one and counting the attempt as a failure. */
      await relay?.stop();
      await io.close();
    },
  };
}
