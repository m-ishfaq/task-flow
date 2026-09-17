import { and, desc, eq, gte, inArray, schema, withPlatformAdminScope } from '@taskflow/db';
import { countRows } from '@taskflow/db';

import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * Error health monitoring — aggregated failure rates across the platform's
 * core subsystems, per-org and global. Used by the platform admin's Error
 * Health tab for configurable-time-range failure dashboards and trend
 * velocity tracking.
 *
 * Data sources (all existing tables, no new migrations):
 * - `platform.operational_events` — mail, billing webhook/sweep, push (global, no orgId)
 * - `platform.automation_runs` — automation engine failures (per-org)
 * - `platform.notification_deliveries` — email/push/sms delivery failures (per-org)
 * - `platform.webhook_deliveries` — dead webhook deliveries (per-org)
 *
 * Aggregation granularity is configurable (1h/6h/24h/7d). A 7-day baseline
 * is always queried in parallel for velocity comparison regardless of the
 * selected window. Velocity = currentRate / 7dAvg; 999 when baseline is 0
 * but current has errors.
 */

type TimeRange = '1h' | '6h' | '24h' | '7d';

function hoursForRange(range: TimeRange): number {
  switch (range) {
    case '1h':
      return 1;
    case '6h':
      return 6;
    case '24h':
      return 24;
    case '7d':
      return 168;
  }
}

function toNumber(val: unknown): number {
  const n = Number(val ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface ErrorHealthSummary {
  totalFailures: number;
  bySource: {
    mail: number;
    automation: number;
    notifications: number;
    webhooks: number;
  };
}

export interface OrgErrorRow {
  orgId: string;
  orgName: string;
  orgSlug: string;
  automationFailures: number;
  notificationFailures: number;
  webhookFailures: number;
  avgDaily7d: number;
  currentRate: number;
  velocity: number;
}

export interface OperationalErrorRow {
  kind: string;
  count: number;
}

export interface RecentOperationalError {
  readonly id: string;
  readonly kind: string;
  readonly target: string | null;
  readonly detail: unknown;
  readonly occurredAt: Date;
}

export interface RecentAutomationFailure {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly triggerEvent: string;
  readonly reason: string | null;
  readonly actionResults: unknown;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

export interface RecentWebhookFailure {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly eventName: string;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly attempts: number;
  readonly createdAt: Date;
}

export interface ErrorHealthResult {
  summary: ErrorHealthSummary;
  orgErrors: readonly OrgErrorRow[];
  operationalErrors: readonly OperationalErrorRow[];
  recentOperational: readonly RecentOperationalError[];
  recentAutomation: readonly RecentAutomationFailure[];
  recentWebhooks: readonly RecentWebhookFailure[];
  timeRange: string;
}

/**
 * Query error health across the platform for a given time range.
 * Returns per-org failure counts with trend velocity and global
 * operational event failures.
 */
export async function queryErrorHealth(
  operator: PlatformOperator,
  input: { timeRange: string },
): Promise<ErrorHealthResult> {
  const timeRange = input.timeRange as TimeRange;
  const hours = hoursForRange(timeRange);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  return withPlatformAdminScope(async (tx) => {
    const [automationByOrg, notificationByOrg, webhookByOrg, operationalByKind] =
      await Promise.all([
        // Automation run failures per org (status = 'failed')
        tx
          .select({
            orgId: schema.automationRuns.orgId,
            count: countRows(schema.automationRuns.id),
          })
          .from(schema.automationRuns)
          .where(
            and(
              eq(schema.automationRuns.status, 'failed'),
              gte(schema.automationRuns.createdAt, cutoff),
            ),
          )
          .groupBy(schema.automationRuns.orgId),

        // Notification delivery failures per org (status = 'failed')
        tx
          .select({
            orgId: schema.notificationDeliveries.orgId,
            count: countRows(schema.notificationDeliveries.id),
          })
          .from(schema.notificationDeliveries)
          .where(
            and(
              eq(schema.notificationDeliveries.status, 'failed'),
              gte(schema.notificationDeliveries.createdAt, cutoff),
            ),
          )
          .groupBy(schema.notificationDeliveries.orgId),

        // Webhook delivery failures per org (status = 'dead')
        tx
          .select({
            orgId: schema.webhookDeliveries.orgId,
            count: countRows(schema.webhookDeliveries.id),
          })
          .from(schema.webhookDeliveries)
          .where(
            and(
              eq(schema.webhookDeliveries.status, 'dead'),
              gte(schema.webhookDeliveries.createdAt, cutoff),
            ),
          )
          .groupBy(schema.webhookDeliveries.orgId),

        // Global operational event failures by kind
        tx
          .select({
            kind: schema.operationalEvents.kind,
            count: countRows(schema.operationalEvents.id),
          })
          .from(schema.operationalEvents)
          .where(
            and(
              eq(schema.operationalEvents.outcome, 'failure'),
              gte(schema.operationalEvents.occurredAt, cutoff),
            ),
          )
          .groupBy(schema.operationalEvents.kind),
      ]);

    // Recent individual failure records (last 20 each) for the detail log
    const [recentOperationalRows, recentAutomationRows, recentWebhookRows] =
      await Promise.all([
        // Recent operational event failures
        tx
          .select({
            id: schema.operationalEvents.id,
            kind: schema.operationalEvents.kind,
            target: schema.operationalEvents.target,
            detail: schema.operationalEvents.detail,
            occurredAt: schema.operationalEvents.occurredAt,
          })
          .from(schema.operationalEvents)
          .where(
            and(
              eq(schema.operationalEvents.outcome, 'failure'),
              gte(schema.operationalEvents.occurredAt, cutoff),
            ),
          )
          .orderBy(desc(schema.operationalEvents.occurredAt))
          .limit(20),

        // Recent failed automation runs
        tx
          .select({
            id: schema.automationRuns.id,
            orgId: schema.automationRuns.orgId,
            triggerEvent: schema.automationRuns.triggerEvent,
            reason: schema.automationRuns.reason,
            actionResults: schema.automationRuns.actionResults,
            durationMs: schema.automationRuns.durationMs,
            createdAt: schema.automationRuns.createdAt,
          })
          .from(schema.automationRuns)
          .where(
            and(
              eq(schema.automationRuns.status, 'failed'),
              gte(schema.automationRuns.createdAt, cutoff),
            ),
          )
          .orderBy(desc(schema.automationRuns.createdAt))
          .limit(20),

        // Recent dead webhook deliveries
        tx
          .select({
            id: schema.webhookDeliveries.id,
            orgId: schema.webhookDeliveries.orgId,
            eventName: schema.webhookDeliveries.eventName,
            lastStatusCode: schema.webhookDeliveries.lastStatusCode,
            lastError: schema.webhookDeliveries.lastError,
            attempts: schema.webhookDeliveries.attempts,
            createdAt: schema.webhookDeliveries.createdAt,
          })
          .from(schema.webhookDeliveries)
          .where(
            and(
              eq(schema.webhookDeliveries.status, 'dead'),
              gte(schema.webhookDeliveries.createdAt, cutoff),
            ),
          )
          .orderBy(desc(schema.webhookDeliveries.createdAt))
          .limit(20),
      ]);

    // 7-day baseline for velocity calculation (always queried regardless of selected window)
    const [automationBaseline, notificationBaseline, webhookBaseline] = await Promise.all([
      tx
        .select({
          orgId: schema.automationRuns.orgId,
          count: countRows(schema.automationRuns.id),
        })
        .from(schema.automationRuns)
        .where(
          and(
            eq(schema.automationRuns.status, 'failed'),
            gte(
              schema.automationRuns.createdAt,
              new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .groupBy(schema.automationRuns.orgId),

      tx
        .select({
          orgId: schema.notificationDeliveries.orgId,
          count: countRows(schema.notificationDeliveries.id),
        })
        .from(schema.notificationDeliveries)
        .where(
          and(
            eq(schema.notificationDeliveries.status, 'failed'),
            gte(
              schema.notificationDeliveries.createdAt,
              new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .groupBy(schema.notificationDeliveries.orgId),

      tx
        .select({
          orgId: schema.webhookDeliveries.orgId,
          count: countRows(schema.webhookDeliveries.id),
        })
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.status, 'dead'),
            gte(
              schema.webhookDeliveries.createdAt,
              new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            ),
          ),
        )
        .groupBy(schema.webhookDeliveries.orgId),
    ]);

    // Build per-org error map
    const orgMap = new Map<
      string,
      {
        automationFailures: number;
        notificationFailures: number;
        webhookFailures: number;
        baseline7d: number;
      }
    >();

    for (const row of automationByOrg) {
      const id = row.orgId;
      const existing = orgMap.get(id) ?? {
        automationFailures: 0,
        notificationFailures: 0,
        webhookFailures: 0,
        baseline7d: 0,
      };
      existing.automationFailures = toNumber(row.count);
      orgMap.set(id, existing);
    }

    for (const row of notificationByOrg) {
      const id = row.orgId;
      const existing = orgMap.get(id) ?? {
        automationFailures: 0,
        notificationFailures: 0,
        webhookFailures: 0,
        baseline7d: 0,
      };
      existing.notificationFailures = toNumber(row.count);
      orgMap.set(id, existing);
    }

    for (const row of webhookByOrg) {
      const id = row.orgId;
      const existing = orgMap.get(id) ?? {
        automationFailures: 0,
        notificationFailures: 0,
        webhookFailures: 0,
        baseline7d: 0,
      };
      existing.webhookFailures = toNumber(row.count);
      orgMap.set(id, existing);
    }

    // Add baseline data
    for (const row of automationBaseline) {
      const existing = orgMap.get(row.orgId);
      if (existing !== undefined) {
        existing.baseline7d += toNumber(row.count);
      }
    }
    for (const row of notificationBaseline) {
      const existing = orgMap.get(row.orgId);
      if (existing !== undefined) {
        existing.baseline7d += toNumber(row.count);
      }
    }
    for (const row of webhookBaseline) {
      const existing = orgMap.get(row.orgId);
      if (existing !== undefined) {
        existing.baseline7d += toNumber(row.count);
      }
    }

    // Resolve org names for non-empty entries
    const orgIds = [...orgMap.keys()].filter((id) => {
      const data = orgMap.get(id);
      return (
        data !== undefined &&
        (data.automationFailures + data.notificationFailures + data.webhookFailures) > 0
      );
    });

    const orgNameMap = new Map<string, { name: string; slug: string }>();
    if (orgIds.length > 0) {
      const orgRows = await tx
        .select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
        .from(schema.orgs)
        .where(inArray(schema.orgs.id, orgIds));
      for (const row of orgRows) {
        orgNameMap.set(row.id, { name: row.name, slug: row.slug });
      }
    }

    // Build result rows
    const orgErrors: OrgErrorRow[] = orgIds.map((orgId) => {
      const data = orgMap.get(orgId);
      if (data === undefined) {
        return {
          orgId,
          orgName: orgId,
          orgSlug: '',
          automationFailures: 0,
          notificationFailures: 0,
          webhookFailures: 0,
          avgDaily7d: 0,
          currentRate: 0,
          velocity: 0,
        };
      }
      const total =
        data.automationFailures + data.notificationFailures + data.webhookFailures;
      const orgNames = orgNameMap.get(orgId);
      const avgDaily7d = data.baseline7d / 7;
      const currentRate = hours > 0 ? (total / hours) * 24 : 0;
      const velocity = avgDaily7d > 0 ? currentRate / avgDaily7d : total > 0 ? 999 : 0;

      return {
        orgId,
        orgName: orgNames?.name ?? orgId,
        orgSlug: orgNames?.slug ?? '',
        automationFailures: data.automationFailures,
        notificationFailures: data.notificationFailures,
        webhookFailures: data.webhookFailures,
        avgDaily7d,
        currentRate,
        velocity,
      };
    });

    // Sort by total failures descending
    orgErrors.sort(
      (a, b) =>
        b.automationFailures +
        b.notificationFailures +
        b.webhookFailures -
        (a.automationFailures + a.notificationFailures + a.webhookFailures),
    );

    // Build operational errors
    const operationalErrors: OperationalErrorRow[] = operationalByKind.map((row) => ({
      kind: row.kind,
      count: toNumber(row.count),
    }));

    // Resolve org names for recent automation/webhook failures
    const recentOrgIds = new Set<string>();
    for (const row of recentAutomationRows) recentOrgIds.add(row.orgId);
    for (const row of recentWebhookRows) recentOrgIds.add(row.orgId);
    const recentOrgIdArray = [...recentOrgIds];

    if (recentOrgIdArray.length > 0) {
      const recentOrgRows = await tx
        .select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
        .from(schema.orgs)
        .where(inArray(schema.orgs.id, recentOrgIdArray));
      for (const row of recentOrgRows) {
        orgNameMap.set(row.id, { name: row.name, slug: row.slug });
      }
    }

    // Build summary
    const totalAutomation = orgErrors.reduce((sum, r) => sum + r.automationFailures, 0);
    const totalNotifications = orgErrors.reduce((sum, r) => sum + r.notificationFailures, 0);
    const totalWebhooks = orgErrors.reduce((sum, r) => sum + r.webhookFailures, 0);
    const totalOperational = operationalErrors.reduce((sum, r) => sum + r.count, 0);
    const summary: ErrorHealthSummary = {
      totalFailures: totalAutomation + totalNotifications + totalWebhooks + totalOperational,
      bySource: {
        mail: operationalErrors.find((r) => r.kind === 'mail')?.count ?? 0,
        automation: totalAutomation,
        notifications: totalNotifications,
        webhooks: totalWebhooks,
      },
    };

    // Audit trail
    await recordOperatorAction(operator.userId, 'error_health.query', { timeRange });

    return {
      summary,
      orgErrors,
      operationalErrors,
      recentOperational: recentOperationalRows.map((r) => ({
        id: r.id,
        kind: r.kind,
        target: r.target,
        detail: r.detail,
        occurredAt: r.occurredAt,
      })),
      recentAutomation: recentAutomationRows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        orgName: orgNameMap.get(r.orgId)?.name ?? r.orgId,
        triggerEvent: r.triggerEvent,
        reason: r.reason,
        actionResults: r.actionResults,
        durationMs: r.durationMs,
        createdAt: r.createdAt,
      })),
      recentWebhooks: recentWebhookRows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        orgName: orgNameMap.get(r.orgId)?.name ?? r.orgId,
        eventName: r.eventName,
        lastStatusCode: r.lastStatusCode,
        lastError: r.lastError,
        attempts: r.attempts,
        createdAt: r.createdAt,
      })),
      timeRange,
    };
  });
}
