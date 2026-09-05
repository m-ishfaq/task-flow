import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { CapabilityGate } from '../../src/lib/capability-gate.js';
import {
  velocityKey,
  cycleTimeKey,
  workloadKey,
  volumeKey,
  last30Days,
  type VelocityPoint,
  type CycleTimeResult,
  type WorkloadEntry,
  type VolumePoint,
} from '../../src/lib/analytics.js';

/**
 * A ratio-derived percentage as the `${number}%` string React Native's
 * `DimensionValue` style type wants. Built by string concatenation rather than
 * a template literal so it does not trip `restrict-template-expressions` (a bare
 * number in a template is a lint error); the cast restores the branded
 * percentage type tsc needs for a style width/height. Same idiom as calls.tsx.
 */
function pct(value: number): `${number}%` {
  return (String(value) + '%') as `${number}%`;
}

/** Extract a human-readable display name from a workload entry. */
function entryDisplayName(entry: {
  readonly userId: string;
  readonly name?: string | null;
  readonly email?: string | null;
}): string {
  if (entry.name) return entry.name;
  if (entry.email) return entry.email.split('@')[0] ?? entry.email;
  return entry.userId.slice(0, 8) + '…';
}

/**
 * Org-wide analytics insights — the mobile counterpart of
 * `apps/web/src/features/analytics/analytics-page.tsx`.
 *
 * **Read-only, slimmed-down**: stat cards and simple bars, not interactive
 * flow charts. The heavy dashboards stay web-first (ai/phase-11-analytics.md
 * §11.1 mobile scope).
 *
 * Admin-and-Owner only (`analytics:read`). `account.tsx` hides the link for
 * non-admins, and this default export additionally wraps the real screen in
 * `CapabilityGate capability="viewAnalytics"` (Phase 15 §1's sweep) — the
 * mobile counterpart of web's route-level `CapabilityGate` on
 * `/analytics`, so a deep link or a stale link lands on a plain "not for
 * your role" screen instead of this component loading and crashing into a
 * raw FORBIDDEN. Still cosmetic only: `analytics.velocity` and friends
 * enforce `analytics:read` themselves regardless of what this renders.
 *
 * Reached from: Account → Insights.
 */
export default function InsightsScreen(): React.JSX.Element | null {
  return (
    <CapabilityGate capability="viewAnalytics">
      <InsightsScreenContent />
    </CapabilityGate>
  );
}

function InsightsScreenContent() {
  const paddingTop = useTopInset();
  const { start, end } = useMemo(last30Days, []);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const velocity = useQuery({
    queryKey: velocityKey(startIso, endIso),
    queryFn: async () =>
      wire(await apiClient.analytics.velocity.query({ startDate: start, endDate: end })),
  });

  const cycleTime = useQuery({
    queryKey: cycleTimeKey(),
    queryFn: async () => wire(await apiClient.analytics.cycleTime.query({})),
  });

  const workload = useQuery({
    queryKey: workloadKey(),
    queryFn: async () => wire(await apiClient.analytics.workload.query({})),
  });

  const volume = useQuery({
    queryKey: volumeKey(startIso, endIso),
    queryFn: async () =>
      wire(await apiClient.analytics.volume.query({ startDate: start, endDate: end })),
  });

  const isLoading =
    velocity.isLoading || cycleTime.isLoading || workload.isLoading || volume.isLoading;
  const hasError = velocity.isError || cycleTime.isError || workload.isError || volume.isError;

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <Pressable
        style={styles.backButton}
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>Insights</Text>
      <Text style={styles.subtitle}>Last 30 days</Text>

      {isLoading && (
        <View style={styles.loadingCenter}>
          <ActivityIndicator color={colors.accent.hex} />
        </View>
      )}

      {hasError && (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>
            Could not load analytics data. You may not have permission to view analytics.
          </Text>
        </View>
      )}

      {!isLoading && !hasError && (
        <View style={styles.sections}>
          {/* Velocity */}
          <Section title="Velocity">
            <VelocityCard points={velocity.data ?? []} days={30} />
          </Section>

          {/* Cycle Time */}
          <Section title="Cycle Time">
            <CycleTimeCard
              result={cycleTime.data ?? { medianHours: 0, p85Hours: 0, count: 0, openCount: 0 }}
            />
          </Section>

          {/* Workload */}
          <Section title="Workload">
            <WorkloadCard entries={workload.data ?? []} />
          </Section>

          {/* Volume */}
          <Section title="Volume">
            <VolumeCard points={volume.data ?? []} />
          </Section>
        </View>
      )}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------- *
 * Section wrapper
 * -------------------------------------------------------------------------- */

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Velocity — simple bar chart
 * -------------------------------------------------------------------------- */

function VelocityCard({
  points,
  days,
}: {
  readonly points: readonly VelocityPoint[];
  readonly days: number;
}) {
  if (points.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.emptyText}>No velocity data yet.</Text>
      </View>
    );
  }

  const total = points.reduce((sum, p) => sum + p.count, 0);
  const maxCount = Math.max(...points.map((p) => p.count), 1);

  return (
    <View style={styles.card}>
      <Text style={styles.statValue}>{total}</Text>
      <Text style={styles.statLabel}>cards done in {days} days</Text>

      {/* Simple bar chart — no interaction, just visual density */}
      <View style={styles.barChart}>
        {points.map((p) => (
          <View key={p.date} style={styles.barWrapper}>
            <View
              style={[
                styles.bar,
                {
                  height: pct(Math.max((p.count / maxCount) * 100, p.count > 0 ? 4 : 0)),
                },
              ]}
            />
          </View>
        ))}
      </View>

      {points.length > 1 && (
        <View style={styles.rangeRow}>
          <Text style={styles.rangeText}>{points[0]?.date}</Text>
          <Text style={styles.rangeText}>{points[points.length - 1]?.date}</Text>
        </View>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Cycle Time — stat cards
 * -------------------------------------------------------------------------- */

function CycleTimeCard({ result }: { readonly result: CycleTimeResult }) {
  const formatHours = (h: number) => {
    if (h < 24) return `${String(Math.round(h))}h`;
    const days = Math.floor(h / 24);
    const hours = Math.round(h % 24);
    return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`;
  };

  return (
    <View style={styles.statGrid}>
      <StatBox label="Median" value={formatHours(result.medianHours)} />
      <StatBox label="P85" value={formatHours(result.p85Hours)} />
      <StatBox label="Completed" value={String(result.count)} />
      <StatBox label="Still open" value={String(result.openCount)} />
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Workload — horizontal bars
 * -------------------------------------------------------------------------- */

function WorkloadCard({ entries }: { readonly entries: readonly WorkloadEntry[] }) {
  if (entries.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.emptyText}>No assigned cards.</Text>
      </View>
    );
  }

  const maxCount = Math.max(...entries.map((e) => e.cardCount), 1);

  return (
    <View style={styles.card}>
      {entries.slice(0, 10).map((entry) => (
        <View key={entry.userId} style={styles.workloadRow}>
          <Text style={styles.workloadLabel} numberOfLines={1}>
            {entryDisplayName(entry)}
          </Text>
          <View style={styles.workloadBarBg}>
            <View
              style={[styles.workloadBar, { width: pct((entry.cardCount / maxCount) * 100) }]}
            />
          </View>
          <Text style={styles.workloadCount}>{entry.cardCount}</Text>
        </View>
      ))}
      {entries.length > 10 && <Text style={styles.rangeText}>+{entries.length - 10} more</Text>}
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Volume — stat cards
 * -------------------------------------------------------------------------- */

function VolumeCard({ points }: { readonly points: readonly VolumePoint[] }) {
  if (points.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.emptyText}>No volume data yet.</Text>
      </View>
    );
  }

  const totalMessages = points.reduce((s, p) => s + p.messages, 0);
  const totalCalls = points.reduce((s, p) => s + p.calls, 0);
  const totalInApp = points.reduce((s, p) => s + p.inAppCalls, 0);
  const totalMinutes = points.reduce((s, p) => s + p.callDurationMinutes, 0);

  return (
    <View style={styles.statGrid}>
      <StatBox label="Messages" value={String(totalMessages)} />
      <StatBox label="PSTN Calls" value={String(totalCalls)} />
      <StatBox label="In-App Calls" value={String(totalInApp)} />
      <StatBox label="Call Minutes" value={Math.round(totalMinutes).toString()} />
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Shared stat box
 * -------------------------------------------------------------------------- */

function StatBox({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statBoxValue}>{value}</Text>
      <Text style={styles.statBoxLabel}>{label}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Styles
 * -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 80,
    gap: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: -4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    marginBottom: 8,
  },
  loadingCenter: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  errorCard: {
    borderRadius: radiusCard,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.danger.hex + '30',
    backgroundColor: colors.danger.hex + '08',
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
  },
  sections: {
    gap: 20,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
    gap: 10,
  },
  emptyText: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  statValue: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    marginTop: -4,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statBox: {
    flexBasis: '47%',
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
  },
  statBoxValue: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  statBoxLabel: {
    fontSize: 11,
    color: colors.inkMuted.hex,
    marginTop: 2,
  },
  /* Velocity bar chart */
  barChart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 80,
    gap: 1,
  },
  barWrapper: {
    flex: 1,
    height: '100%',
    justifyContent: 'flex-end',
  },
  bar: {
    backgroundColor: colors.accent.hex + '60',
    borderRadius: 2,
    minHeight: 0,
  },
  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rangeText: {
    fontSize: 10,
    color: colors.inkFaint.hex,
  },
  /* Workload rows */
  workloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  workloadLabel: {
    width: 56,
    fontSize: 11,
    color: colors.inkMuted.hex,
  },
  workloadBarBg: {
    flex: 1,
    height: 14,
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 3,
    overflow: 'hidden',
  },
  workloadBar: {
    height: '100%',
    backgroundColor: colors.accent.hex + '60',
    borderRadius: 3,
  },
  workloadCount: {
    width: 28,
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
    textAlign: 'right',
  },
});
