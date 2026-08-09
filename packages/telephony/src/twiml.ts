import { z } from 'zod';
import { RECORDING_ANNOUNCEMENT } from './consent.js';

/**
 * TwiML generation and the inbound-routing config (ai/phase-7-voice.md §3.10,
 * Wave 2 — "inbound routing with IVR and queues").
 *
 * ## TwiML is markup we serve to a third party, so it is XML-escaped, always
 *
 * A call's instructions are XML that Twilio fetches and executes. Every dynamic
 * value in it — a greeting an admin typed, a caller's number — is attacker- or
 * user-influenced text landing inside markup, which is the same injection shape
 * as HTML and is handled the same way: **nothing is interpolated unescaped.**
 *
 * This is also why the routing config is a closed schema of VERBS rather than a
 * TwiML string an admin can type. A settings field containing raw TwiML would be
 * stored XML executed by a third party with the org's money attached — an admin
 * could `<Dial>` a premium number, and the geo allowlist would never see it
 * because no outbound API call was ever made from here. The config below can
 * only express destinations this system already knows about.
 *
 * ## The one guarantee about recording
 *
 * `<Record>` is never emitted before the announcement `<Say>` when consent
 * requires one (§3.5). The ordering is enforced here, in `routeToTwiml`, AND by
 * a CHECK constraint on `comms.calls` — a UI affordance a caller could skip is
 * not a control, and neither is a code path a second call site could bypass.
 */

/* -------------------------------------------------------------------------- *
 * The routing config
 * -------------------------------------------------------------------------- */

/** Ring one org member's forwarding number. */
const DialUserAction = z
  .object({
    kind: z.literal('dial_user'),
    /** Resolved to a verified forwarding number by the caller, never dialled raw. */
    userId: z.string().uuid(),
  })
  .strict();

/**
 * Ring several members, in order or all at once.
 *
 * This is the "queue" of §3.4's "IVR and queues", built as a hunt group rather
 * than as a parked-caller queue with hold music and position announcements. A
 * real ACD queue needs agent presence, wrap-up state, and abandonment metrics —
 * a Phase 11 analytics surface, not a Phase 7 routing primitive — and shipping
 * a half-queue that silently drops callers would be worse than shipping a hunt
 * group that plainly does not claim to be one.
 */
const HuntAction = z
  .object({
    kind: z.literal('hunt'),
    userIds: z.array(z.string().uuid()).min(1).max(10),
    strategy: z.enum(['simultaneous', 'sequential']),
    /** Seconds to ring before moving on / giving up. */
    ringSeconds: z.number().int().min(5).max(120).default(20),
  })
  .strict();

/** Say something and hang up. The terminal action for out-of-hours. */
const SayAction = z.object({ kind: z.literal('say'), text: z.string().min(1).max(500) }).strict();

/** Record a voicemail. Subject to the same consent gate as a call recording. */
const VoicemailAction = z
  .object({
    kind: z.literal('voicemail'),
    greeting: z.string().min(1).max(500),
    maxSeconds: z.number().int().min(10).max(600).default(120),
  })
  .strict();

const LeafAction = z.discriminatedUnion('kind', [
  DialUserAction,
  HuntAction,
  SayAction,
  VoicemailAction,
]);

export type LeafRouteAction = z.infer<typeof LeafAction>;

/**
 * An IVR menu: a prompt, and a destination per digit.
 *
 * ONE level deep, deliberately. Nested menus are a tree whose depth has to be
 * bounded somewhere — an unbounded one is a config that can make this server
 * generate unbounded markup — and one level covers "press 1 for sales, 2 for
 * support" without needing a recursive Zod schema whose depth limit would be
 * the real control anyway.
 */
const MenuRoute = z
  .object({
    kind: z.literal('menu'),
    prompt: z.string().min(1).max(500),
    /** Digit -> what happens. A digit absent from the map re-prompts. */
    choices: z.record(z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']), LeafAction),
    /** Used when the caller presses nothing. */
    fallback: LeafAction,
  })
  .strict();

export const InboundRoute = z.discriminatedUnion('kind', [
  DialUserAction,
  HuntAction,
  SayAction,
  VoicemailAction,
  MenuRoute,
]);

export type InboundRouteConfig = z.infer<typeof InboundRoute>;

/* -------------------------------------------------------------------------- *
 * XML
 * -------------------------------------------------------------------------- */

/**
 * Escapes text for an XML text node or attribute value.
 *
 * All five predefined entities, including both quote forms, because the same
 * function is used for attribute values — escaping only `<` and `&` is correct
 * for text nodes and lets a value break out of an attribute.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface TwimlContext {
  /**
   * Resolves an org member to a dialable number.
   *
   * Returns undefined when the member has no verified forwarding number, and the
   * caller then falls through rather than dialling something unverified. This is
   * a function rather than a map baked into the config so that a number cannot
   * be frozen into stored config and keep being dialled after it changed hands.
   */
  readonly forwardingNumberFor: (userId: string) => string | undefined;
  /** Absolute URL the carrier posts recording callbacks to. */
  readonly recordingCallbackUrl: string;
  /** Absolute URL for the caller's menu selection. */
  readonly menuActionUrl: string;
  /** Whether an announcement must play before any recording starts (§3.5). */
  readonly announcementRequired: boolean;
  /** Whether this call is being recorded at all. */
  readonly record: boolean;
}

/** Wraps verbs in the document envelope. */
function document(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/**
 * Renders the routing config for an inbound call.
 *
 * The announcement is emitted FIRST when recording is on and consent requires
 * it, before any verb that could capture audio. That ordering is the control
 * §3.5 describes, and it is why this function — not its callers — decides where
 * `<Say>` goes.
 */
export function routeToTwiml(route: InboundRouteConfig, context: TwimlContext): string {
  const preamble =
    context.record && context.announcementRequired
      ? `<Say>${escapeXml(RECORDING_ANNOUNCEMENT)}</Say>`
      : '';

  if (route.kind === 'menu') {
    /* `numDigits="1"` and a short timeout, because an IVR that waits forever
       holds a billable call open. The fallback runs on timeout. */
    const gather =
      `<Gather numDigits="1" timeout="7" action="${escapeXml(context.menuActionUrl)}" method="POST">` +
      `<Say>${escapeXml(route.prompt)}</Say>` +
      `</Gather>` +
      leafToTwiml(route.fallback, context);

    return document(preamble + gather);
  }

  return document(preamble + leafToTwiml(route, context));
}

/** Renders the destination a caller reached by pressing a digit. */
export function menuChoiceToTwiml(
  route: InboundRouteConfig,
  digit: string,
  context: TwimlContext,
): string {
  if (route.kind !== 'menu') return routeToTwiml(route, context);

  /* An unknown digit falls back rather than erroring. A caller pressing 7 on a
     two-option menu is an ordinary mistake, and answering it with a 500 drops a
     live call. */
  const chosen = route.choices[digit as '0'] ?? route.fallback;

  /* No preamble here: the announcement already played on the first document of
     this call, before the <Gather>. Repeating it would announce recording twice
     on every menu selection. */
  return document(leafToTwiml(chosen, context));
}

function leafToTwiml(action: LeafRouteAction, context: TwimlContext): string {
  switch (action.kind) {
    case 'say':
      return `<Say>${escapeXml(action.text)}</Say><Hangup/>`;

    case 'dial_user': {
      const number = context.forwardingNumberFor(action.userId);
      /* No verified forwarding number means we do NOT dial. The alternative —
         falling back to some other number — would be this system placing a call
         to a destination nobody configured. */
      if (number === undefined) return unavailable();
      return `<Dial${recordAttribute(context)}>${dialNumber(number, context)}</Dial>`;
    }

    case 'hunt': {
      const numbers = action.userIds
        .map((userId) => context.forwardingNumberFor(userId))
        .filter((value): value is string => value !== undefined);

      if (numbers.length === 0) return unavailable();

      if (action.strategy === 'simultaneous') {
        /* Every <Number> inside one <Dial> rings at once; the first to answer
           wins and Twilio cancels the rest. */
        return (
          `<Dial timeout="${String(action.ringSeconds)}"${recordAttribute(context)}>` +
          numbers.map((number) => dialNumber(number, context)).join('') +
          `</Dial>`
        );
      }

      /* Sequential: consecutive <Dial> verbs. Twilio moves to the next only if
         the previous did not connect, which is exactly hunt-group semantics
         without needing any state on our side. */
      return numbers
        .map(
          (number) =>
            `<Dial timeout="${String(action.ringSeconds)}"${recordAttribute(context)}>` +
            dialNumber(number, context) +
            `</Dial>`,
        )
        .join('');
    }

    case 'voicemail':
      return (
        `<Say>${escapeXml(action.greeting)}</Say>` +
        `<Record maxLength="${String(action.maxSeconds)}" playBeep="true" ` +
        `recordingStatusCallback="${escapeXml(context.recordingCallbackUrl)}" ` +
        `recordingStatusCallbackMethod="POST"/>` +
        `<Hangup/>`
      );
  }
}

function dialNumber(number: string, _context: TwimlContext): string {
  return `<Number>${escapeXml(number)}</Number>`;
}

/**
 * The recording attribute for a `<Dial>`.
 *
 * Empty when the call is not being recorded — and note that this function is
 * the ONLY place that can turn recording on for a bridged call. A `record`
 * attribute written inline at a call site is how a code path acquires the
 * ability to record without passing the consent gate.
 */
function recordAttribute(context: TwimlContext): string {
  if (!context.record) return '';
  return (
    ` record="record-from-answer-dual"` +
    ` recordingStatusCallback="${escapeXml(context.recordingCallbackUrl)}"` +
    ` recordingStatusCallbackMethod="POST"`
  );
}

function unavailable(): string {
  return `<Say>${escapeXml('Sorry, nobody is available to take your call right now.')}</Say><Hangup/>`;
}

/**
 * The instructions for an OUTBOUND click-to-call.
 *
 * Two legs: the carrier calls the agent first, and only when the agent picks up
 * does it dial the customer. Doing it the other way — customer first — rings a
 * member of the public and then makes them wait while we find the agent, which
 * is the behaviour that gets a number reported as spam.
 */
export function outboundTwiml(options: {
  readonly to: string;
  readonly callerId: string;
  readonly context: TwimlContext;
}): string {
  const preamble =
    options.context.record && options.context.announcementRequired
      ? `<Say>${escapeXml(RECORDING_ANNOUNCEMENT)}</Say>`
      : '';

  return document(
    preamble +
      `<Dial callerId="${escapeXml(options.callerId)}"${recordAttribute(options.context)}>` +
      `<Number>${escapeXml(options.to)}</Number>` +
      `</Dial>`,
  );
}
