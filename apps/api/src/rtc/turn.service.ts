import { outboxWriter, withOrgScope } from '@taskflow/db';
import { errors } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { turnCredentialIssued } from './events.js';
import { checkTurnAllowed, emitTurnRefusal } from './turn-gate.js';
import { enforceCanJoinSession } from './session.service.js';
import { envelopeOf, orgOf, userOf, type RtcActor } from './shared.js';
import type { RtcDeps } from './deps.js';

/**
 * ICE server configuration, minted per call (ai/phase-13-webrtc.md §3.3, §3.4).
 * ⚠ Human-review surface — this hands out a relay capability.
 *
 * ## Why this is a MUTATION and not a query
 *
 * It writes an `rtc.turn_issuance` row and emits a domain event, which is
 * already enough. But the naming matters beyond the plumbing: a client that
 * treats "get ICE servers" as a cacheable read will refetch it on every render,
 * and each refetch spends budget. Declaring it a mutation makes the cost visible
 * in the one place a reader looks for side effects.
 *
 * ## Two gates, and they answer different questions
 *
 *   1. `enforceCanJoinSession` — `can()` on the session's CHANNEL. May this
 *      person be in this conversation at all? This is the §1 decision, made the
 *      same way everywhere.
 *   2. `checkTurnAllowed` — org freeze, actual participation, and the durable
 *      issuance budget. Should this deployment spend bandwidth on them?
 *
 * The first is authorization and the second is spend. Someone who can read the
 * channel passes the first and is refused by the second until they have actually
 * joined the call, which is deliberate: a credential handed to everyone who
 * COULD join is a credential handed to everyone in the org's largest channel.
 */

export interface IceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface IceConfiguration {
  readonly iceServers: readonly IceServer[];
  /** Passed to `RTCPeerConnection` verbatim. */
  readonly iceTransportPolicy: 'all' | 'relay';
  /** When the TURN credential dies; null when no relay is configured. */
  readonly expiresAt: Date | null;
}

export async function issueIceServers(
  actor: RtcActor,
  deps: RtcDeps,
  input: { readonly sessionId: string },
): Promise<IceConfiguration> {
  /* Authorization first, and against the CHANNEL. A refusal here is NOT_FOUND
     or FORBIDDEN and never touches the issuance budget — someone probing
     session ids they cannot reach must not be able to exhaust a real org's
     daily allowance. */
  await enforceCanJoinSession(actor, input.sessionId);

  const stun: readonly IceServer[] =
    deps.stunUrls.length > 0 ? [{ urls: deps.stunUrls }] : [];

  /* No relay configured is a VALID deployment (§5): STUN alone connects on most
     networks. Answering with what exists, rather than erroring, is the honest
     behaviour — and the env schema has already refused to boot on the
     half-configured case that would otherwise fail silently here. */
  if (deps.turnUrls.length === 0 || deps.turnSecret === undefined) {
    return {
      iceServers: stun,
      iceTransportPolicy: deps.iceTransportPolicy,
      expiresAt: null,
    };
  }

  const decision = await checkTurnAllowed(
    { orgId: orgOf(actor), userId: userOf(actor), sessionId: input.sessionId },
    { capPerWindow: deps.turnIssuanceCapPerDay, ttlSeconds: deps.turnTtlSeconds },
  );

  if (!decision.allowed) {
    /* Two obligations on a refusal — an event and an error — and the event goes
       first, in its own transaction, because throwing would roll back anything
       appended alongside it. */
    await emitTurnRefusal(actor, decision);

    if (decision.reason === 'org_suspended') {
      throw errors.orgSuspended();
    }
    if (decision.reason === 'issuance_cap') {
      throw errors.quotaExceeded(
        'This organization has reached its daily relay allowance. Calls may still connect directly.',
      );
    }
    /* `not_a_participant` and `session_over` are both FORBIDDEN rather than
       NOT_FOUND: the caller has already proven they can read the channel, so
       there is nothing left to disclose by being specific about which. */
    throw errors.forbidden('You are not in this call.');
  }

  /* ONLY now. Everything above could refuse; nothing above has used the secret.
     §3.4's acceptance bar is that a refused request never reaches this line, and
     `deps.mint` is a seam precisely so a test can assert it. */
  const credential = deps.mint({
    secret: deps.turnSecret,
    /* The SESSION id, not the user id. coturn logs the username on every
       allocation, and TURN logs are operational data with a different audience
       and retention from this database. Who was issued what is recorded in
       `rtc.turn_issuance`, under RLS, where it belongs. */
    identity: input.sessionId,
    ttlSeconds: deps.turnTtlSeconds,
  });

  await withOrgScope(orgOf(actor), async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        turnCredentialIssued,
        { sessionId: input.sessionId, ttlSeconds: deps.turnTtlSeconds },
        envelopeOf(actor),
      ),
    ]);
  });

  return {
    iceServers: [
      ...stun,
      {
        urls: deps.turnUrls,
        username: credential.username,
        credential: credential.credential,
      },
    ],
    iceTransportPolicy: deps.iceTransportPolicy,
    expiresAt: credential.expiresAt,
  };
}
