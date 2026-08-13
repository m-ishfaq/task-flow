import { and, eq, gte, schema, sumWithFallback, withOrgScope } from '@taskflow/db';
import type { MailQueue } from '@taskflow/mail';
import type { OrgId } from '@taskflow/contracts';

/**
 * Billing email — the one notification class that does NOT batch
 * (Phase 12 Wave 4).
 *
 * ## Why this bypasses the notification projection entirely
 *
 * Every other notification in this system is deliberately polite: it lands in
 * `platform.notifications`, respects the recipient's channel preferences, and
 * can be rolled into a digest. That is right for "someone mentioned you" and
 * wrong for "your payment failed and you have seven days" — a warning batched
 * into a weekly digest arrives after the deadline it was warning about.
 *
 * So these send directly through the mail queue. Routing them through a
 * mechanism built to defer them, and then adding an exception flag to defeat
 * it, would leave the exception one refactor away from being forgotten.
 *
 * ## The recipient is always the OWNER, and that is not a shortcut
 *
 * `org:billing` is Owner-only and ORG_LEVEL — no resource tuple can grant it
 * (`packages/policy`'s own note). An admin who received "your payment failed"
 * could not open the billing page to act on it. Telling the only person who
 * can do something is the whole point, and telling anyone else is noise about
 * a problem they cannot fix.
 *
 * These events also carry `actorId: null` — they come from a webhook or a
 * sweep, not from a person — so there is no actor to fall back on even if we
 * wanted one.
 *
 * ## Failure is logged, never thrown
 *
 * `MailQueue.enqueue` returns immediately and retries in the background; a
 * dead SMTP relay must not roll back the transaction that recorded a real
 * payment failure. Delivery outcomes reach the operations dashboard through
 * the queue's own `onFailure`/`onSuccess` hooks, which is where an operator
 * looks when a customer says they were never told.
 */

export interface BillingMailDeps {
  readonly queue: MailQueue;
  readonly webOrigin: string;
}

/** Every billing email this system sends. A closed union, like the flag registry. */
export type BillingMailKind =
  | 'payment_failed'
  | 'trial_ending'
  | 'plan_changed'
  | 'subscription_canceled'
  | 'usage_80'
  | 'usage_100'
  | 'usage_over';

interface Recipient {
  readonly email: string;
  readonly name: string | null;
}

/**
 * The org's owner and its display name, or null when there is nobody to tell.
 *
 * Null is a real answer rather than an error: an org whose owner account was
 * deleted still has billing events, and failing the webhook over an
 * unreachable mailbox would turn "we could not warn them" into "we lost the
 * payment record".
 */
async function ownerOf(orgId: OrgId): Promise<{ to: Recipient; orgName: string } | null> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        email: schema.users.email,
        name: schema.profiles.displayName,
        fallbackName: schema.users.displayName,
        orgName: schema.orgs.name,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      /* LEFT — a profile row is lazily created; an inner join would mean an
         owner who never opened the account page is never emailed. */
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    return {
      to: { email: row.email, name: row.name ?? row.fallbackName },
      orgName: row.orgName,
    };
  });
}

/** Cents to a display string. Integer arithmetic only — money is never a float. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface Copy {
  readonly subject: string;
  readonly body: string;
}

/**
 * The wording, kept in one place.
 *
 * Every one of these names what happened, what it means, and what to do — in
 * that order. A billing email whose reader has to work out whether it needs
 * action has failed at the only job it has.
 */
function copyFor(
  kind: BillingMailKind,
  context: {
    readonly orgName: string;
    readonly deadline: Date | null;
    readonly planName: string | null;
    readonly spentCents: number | null;
    readonly capCents: number | null;
  },
): Copy {
  const when = context.deadline?.toDateString() ?? null;
  const org = context.orgName;

  switch (kind) {
    case 'payment_failed':
      return {
        subject: `Payment failed for ${org}`,
        body:
          `A recent payment for ${org} could not be completed.\n\n` +
          (when === null
            ? 'Please update the payment method to avoid an interruption.'
            : `Update the payment method by ${when} to avoid an interruption.`) +
          '\n\nNothing has changed yet — everything is still available.',
      };

    case 'trial_ending':
      return {
        subject: `${org}'s trial ends ${when ?? 'soon'}`,
        body:
          `The trial for ${org} ends ${when ?? 'soon'}.\n\n` +
          'Choose a plan to keep everything you have set up. If you do nothing, the ' +
          'organization moves to the free plan — your data stays exactly where it is, ' +
          'and the features the free plan does not include become unavailable until you upgrade.',
      };

    case 'plan_changed':
      return {
        subject: `${org} is now on ${context.planName ?? 'a new plan'}`,
        body:
          `${org} has moved to ${context.planName ?? 'a new plan'}.\n\n` +
          (when === null ? 'This is effective now.' : `This takes effect on ${when}.`),
      };

    case 'subscription_canceled':
      return {
        subject: `${org}'s subscription has been cancelled`,
        body:
          `The subscription for ${org} has been cancelled.\n\n` +
          (when === null
            ? 'Access to paid features has ended.'
            : `Everything stays available until ${when}, then the organization moves to the free plan.`) +
          '\n\nYour data is not deleted. Resubscribing restores access to it immediately.',
      };

    /* The usage alerts say the NUMBER, not just the threshold. "You have used
       80% of your allowance" leaves the reader to go and find out of what. */
    case 'usage_80':
    case 'usage_100':
      return {
        subject:
          kind === 'usage_80'
            ? `${org} has used 80% of its calling allowance`
            : `${org} has reached its calling limit`,
        body:
          `${org} has used ${money(context.spentCents ?? 0)} of its ` +
          `${money(context.capCents ?? 0)} limit for calls and messages over the last 30 days.\n\n` +
          (kind === 'usage_100'
            ? 'Outbound calls and messages are now being refused. An owner can raise the limit ' +
              'in Billing settings, up to the maximum the plan allows.'
            : 'No action is needed yet. Outbound calls and messages stop when the limit is reached.'),
      };

    case 'usage_over':
      return {
        subject: `${org} has usage beyond its included allowance`,
        body:
          `${org} has used ${money(context.spentCents ?? 0)} on calls and messages, which is ` +
          'past the amount included in its plan.\n\n' +
          'The difference will appear on the next invoice. Nothing has been interrupted.',
      };
  }
}

/**
 * Sends one billing email to the org's owner.
 *
 * Returns whether anything was queued, so a caller that also records a
 * "already warned" marker can avoid writing one for a mail that was never
 * sent — an org with no reachable owner would otherwise be marked as warned
 * forever.
 */
export async function sendBillingMail(
  deps: BillingMailDeps,
  orgId: OrgId,
  kind: BillingMailKind,
  context: {
    readonly deadline?: Date | null;
    readonly planName?: string | null;
    readonly spentCents?: number | null;
    readonly capCents?: number | null;
  } = {},
): Promise<boolean> {
  const owner = await ownerOf(orgId);
  if (owner === null) return false;

  const copy = copyFor(kind, {
    orgName: owner.orgName,
    deadline: context.deadline ?? null,
    planName: context.planName ?? null,
    spentCents: context.spentCents ?? null,
    capCents: context.capCents ?? null,
  });

  const settingsUrl = `${deps.webOrigin}/settings`;

  deps.queue.enqueue({
    to: owner.to.email,
    subject: copy.subject,
    text: `${copy.body}\n\nBilling settings: ${settingsUrl}`,
    html: renderHtml(copy.body, settingsUrl),
  });

  return true;
}

/**
 * The HTML half, with every interpolated value escaped.
 *
 * The org NAME reaches these emails and is user-supplied — an org called
 * `<img src=x onerror=...>` would otherwise ship script into its own owner's
 * inbox, and into any support mailbox the thread is forwarded to. Guardrail 4
 * bans `dangerouslySetInnerHTML` in the app for the same reason this escapes
 * here: the only safe way to put a user string in markup is to stop it being
 * markup.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtml(body: string, settingsUrl: string): string {
  const paragraphs = body
    .split('\n\n')
    .map((line) => `<p>${escapeHtml(line).replaceAll('\n', '<br />')}</p>`)
    .join('');

  return `${paragraphs}<p><a href="${escapeHtml(settingsUrl)}">Billing settings</a></p>`;
}

/**
 * Sends a usage alert at most ONCE per threshold per window.
 *
 * The check that calls this runs on every outbound call, so without a durable
 * marker an org sitting at 81% emails its owner on every call for the rest of
 * the month. `billing.alerts_sent` (migration 0067) is that marker, and the
 * INSERT is what decides — `ON CONFLICT DO NOTHING` means two workers racing
 * on the same threshold send exactly one email between them, adjudicated by
 * Postgres rather than by a check-then-act both would pass.
 *
 * The mail is queued only when the INSERT actually claimed the row. Ordering
 * it the other way round would send first and then discover a duplicate.
 */
export async function sendUsageAlertOnce(
  deps: BillingMailDeps,
  orgId: OrgId,
  alert: 'usage_80' | 'usage_100' | 'usage_over',
  windowStart: Date,
  context: { readonly spentCents: number; readonly capCents: number },
): Promise<boolean> {
  const claimed = await withOrgScope(orgId, async (tx) => {
    const result = await tx
      .insert(schema.alertsSent)
      .values({ orgId, alert, periodStart: windowStart })
      .onConflictDoNothing();
    return (result.rowCount ?? 0) > 0;
  });

  if (!claimed) return false;

  return sendBillingMail(deps, orgId, alert, {
    spentCents: context.spentCents,
    capCents: context.capCents,
  });
}

/**
 * Warns the owner before a trial runs out.
 *
 * Lives here rather than in `sweep.service.ts` for the reason guardrail 11
 * pointed out when it did: writing an `alerts_sent` row from a
 * `*.service.ts` file reads as a domain mutation that emits no event. It is
 * not one — it is dedupe bookkeeping for an email, the same shape
 * `sendUsageAlertOnce` below already has, and it belongs with the other
 * alert sender rather than among the state transitions.
 *
 * Sent once per trial, keyed on the trial's own END DATE — so extending a
 * trial re-arms the warning, and a sweep ticking every minute does not email
 * every minute.
 */
export async function warnTrialEnding(
  orgId: OrgId,
  deps: { readonly warningHours: number; readonly mail?: BillingMailDeps | undefined },
): Promise<boolean> {
  if (deps.mail === undefined) return false;

  const trialEndsAt = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ trialEndsAt: schema.orgs.trialEndsAt, billingStatus: schema.orgs.billingStatus })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    const row = rows[0];
    if (row?.billingStatus !== 'trialing' || row.trialEndsAt === null) return null;
    return row.trialEndsAt;
  });

  if (trialEndsAt === null) return false;

  /* Only inside the window, and only while the deadline is still ahead — a
     trial that already ran out gets the SWITCH, not a warning about it. */
  const msUntil = trialEndsAt.getTime() - Date.now();
  if (msUntil <= 0 || msUntil > deps.warningHours * 60 * 60 * 1000) return false;

  const claimed = await withOrgScope(orgId, async (tx) => {
    const result = await tx
      .insert(schema.alertsSent)
      .values({ orgId, alert: 'trial_ending', periodStart: trialEndsAt })
      .onConflictDoNothing();
    return (result.rowCount ?? 0) > 0;
  });

  if (!claimed) return false;

  return sendBillingMail(deps.mail, orgId, 'trial_ending', { deadline: trialEndsAt });
}

/**
 * Checks an org's spend against its cap and warns at 80% and 100%.
 *
 * Called AFTER a spend-bearing action is recorded, never before: the check
 * reads the ledger, and reading it before the row lands would warn one call
 * late forever. Deliberately does not gate anything — the spend cap itself is
 * the control, enforced by `checkOutboundAllowed`, and this only tells someone
 * about it.
 */
export async function checkUsageThresholds(
  deps: BillingMailDeps,
  orgId: OrgId,
  capCents: number | null,
  windowDays: number,
): Promise<void> {
  /* No cap means nothing to be a percentage of. */
  if (capCents === null || capCents <= 0) return;

  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const spentCents = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        /* COALESCE(actual, estimated) — the same number the gate enforces
           against. SUM(actual) alone counts in-flight calls as free, which
           would warn late and under-report. */
        total: sumWithFallback(schema.spendLedger.actualCents, schema.spendLedger.estimatedCents),
      })
      .from(schema.spendLedger)
      .where(
        and(eq(schema.spendLedger.orgId, orgId), gte(schema.spendLedger.occurredAt, windowStart)),
      );
    return Number(rows[0]?.total ?? 0);
  });

  const ratio = spentCents / capCents;

  /* 100% first: an org that crosses both thresholds in one call should hear
     the one that matters, and both markers are written either way so neither
     fires again this window. */
  if (ratio >= 1) {
    await sendUsageAlertOnce(deps, orgId, 'usage_100', windowStart, { spentCents, capCents });
  }
  if (ratio >= 0.8) {
    await sendUsageAlertOnce(deps, orgId, 'usage_80', windowStart, { spentCents, capCents });
  }
}
