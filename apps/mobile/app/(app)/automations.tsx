import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { CapabilityGate } from '../../src/lib/capability-gate.js';
import {
  AUTOMATIONS_QUERY_KEY,
  actionOutcomeOf,
  automationRunsQueryKey,
  canEditOnMobile,
  describeAction,
  explainReason,
  explainStatus,
  statusColor,
  triggerLabel,
  type AutomationRun,
  type AutomationSummary,
} from '../../src/lib/automation.js';

/**
 * Automation rules — read, toggle, delete, and run history, reached from
 * `account.tsx`'s "Automations" link (a sibling of "Manage organization":
 * both are org-level configuration links, not tab-bar destinations someone
 * browses between other work — the same reasoning that moved Account
 * itself out of the tab bar applies to this screen from the start rather
 * than needing a later move).
 *
 * `automation:manage` is Admin-and-Owner by role, or an individual grant
 * (Wave 2, ai/phase-15-ai-copilot-and-permissions.md §1) — `account.tsx`
 * hides the link for anyone with neither (Phase 15 §1's sweep fixed a real
 * gap here: it previously rendered unconditionally with no gate at all,
 * unlike "Insights" two links below it), and this default export
 * additionally wraps the screen in `CapabilityGate capability=
 * "manageAutomations"` so a deep link lands on a plain "not for your role"
 * screen rather than loading straight into a raw FORBIDDEN. Not an "any
 * of" the four automation permissions the web sidebar now checks — this
 * screen is Rules only, so `manageAutomations` alone is the correct floor;
 * someone granted only `webhook:manage` has no mobile UI to reach at all.
 *

 * **Creating and editing a rule now ship too — `automation-editor.tsx`,
 * pushed from the "+ New rule" button below and from a `RuleRow`'s own
 * "Edit" action.** `automation.ts`'s own header has the full account of
 * the two real boundaries that editor draws (no condition, no webhook or
 * connector actions) rather than a silent gap. `RuleRow`'s "Edit" only
 * ever appears when `canEditOnMobile(rule)` says the rule is one this
 * editor can fully and safely represent — a rule with a condition, or
 * with an action this platform has no picker for, still gets
 * Enable/Disable, Runs, and Delete, just not Edit; opening it stays "go
 * to web" rather than a form that would silently drop what it cannot
 * show.
 */
export default function AutomationsScreen(): React.JSX.Element | null {
  return (
    <CapabilityGate capability="manageAutomations">
      <AutomationsScreenContent />
    </CapabilityGate>
  );
}

function AutomationsScreenContent() {
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rules = useInfiniteQuery({
    queryKey: AUTOMATIONS_QUERY_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | null }) =>
      wire(
        await apiClient.automation.list.query({
          ...(pageParam === null ? {} : { cursor: pageParam }),
          limit: 50,
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY });
  };

  const rows = rules.data?.pages.flatMap((page) => page.automations) ?? [];

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Pressable
        style={styles.backButton}
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      <View style={styles.titleRow}>
        <View style={styles.titleColumn}>
          <Text style={styles.title}>Automations</Text>
          <Text style={styles.subtitle}>
            Rules that react to what happens on a card, a comment, or a connected app.
          </Text>
        </View>
        <Pressable
          style={styles.newRuleButton}
          onPress={() => {
            router.push('/automation-editor');
          }}
        >
          <Text style={styles.newRuleButtonText}>+ New rule</Text>
        </Pressable>
      </View>

      {rules.isPending && <ActivityIndicator style={styles.loading} color={colors.accent.hex} />}
      {rules.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(rules.error)?.error.message ?? 'Could not load automation rules.'}
        </Text>
      )}
      {rules.isSuccess && rows.length === 0 && (
        <Text style={styles.emptyHint}>
          No automation rules yet. Tap "+ New rule" above, or build a more advanced one on web.
        </Text>
      )}

      <FlatList<AutomationSummary>
        data={rows}
        keyExtractor={(rule) => rule.automationId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <RuleRow
            rule={item}
            expanded={expandedId === item.automationId}
            onToggleExpanded={() => {
              setExpandedId(expandedId === item.automationId ? null : item.automationId);
            }}
            onChanged={invalidate}
          />
        )}
        ListFooterComponent={
          rules.hasNextPage ? (
            <Pressable
              style={styles.loadMoreButton}
              disabled={rules.isFetchingNextPage}
              onPress={() => {
                void rules.fetchNextPage();
              }}
            >
              {rules.isFetchingNextPage ? (
                <ActivityIndicator color={colors.accent.hex} />
              ) : (
                <Text style={styles.loadMoreText}>Load more</Text>
              )}
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function RuleRow({
  rule,
  expanded,
  onToggleExpanded,
  onChanged,
}: {
  readonly rule: AutomationSummary;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly onChanged: () => void;
}) {
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      apiClient.automation.setEnabled.mutate({ automationId: rule.automationId, enabled }),
    onSuccess: onChanged,
    onError: (error: unknown) => {
      Alert.alert('The rule could not be updated', apiErrorOf(error)?.error.message);
    },
  });

  const remove = useMutation({
    mutationFn: () => apiClient.automation.delete.mutate({ automationId: rule.automationId }),
    onSuccess: onChanged,
    onError: (error: unknown) => {
      Alert.alert('The rule could not be deleted', apiErrorOf(error)?.error.message);
    },
  });

  const confirmDelete = () => {
    Alert.alert('Delete this rule?', rule.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          remove.mutate();
        },
      },
    ]);
  };

  return (
    <View style={[styles.ruleCard, !rule.enabled && styles.ruleCardDisabled]}>
      <View style={styles.ruleHeader}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: rule.enabled ? colors.success.hex : colors.inkFaint.hex },
          ]}
        />
        <Text style={styles.ruleName} numberOfLines={1}>
          {rule.name}
        </Text>
        {rule.conditionBroken && (
          <View style={styles.brokenBadge}>
            <Text style={styles.brokenBadgeText}>Broken</Text>
          </View>
        )}
      </View>

      <Text style={styles.ruleSummary} numberOfLines={3}>
        <Text style={styles.ruleSummaryFaint}>When </Text>
        <Text style={styles.ruleSummaryMuted}>{triggerLabel(rule.triggerEvent)}</Text>
        {rule.condition !== null && (
          <Text style={styles.ruleSummaryFaint}> and a condition matches</Text>
        )}
        <Text style={styles.ruleSummaryFaint}> → </Text>
        <Text style={styles.ruleSummaryMuted}>
          {rule.actions.map((action) => describeAction(action)).join(', ')}
        </Text>
      </Text>

      <View style={styles.ruleActions}>
        <Pressable
          style={styles.ruleActionButton}
          disabled={setEnabled.isPending}
          onPress={() => {
            setEnabled.mutate(!rule.enabled);
          }}
        >
          <Text style={styles.ruleActionText}>{rule.enabled ? 'Disable' : 'Enable'}</Text>
        </Pressable>
        {canEditOnMobile(rule) && (
          <Pressable
            style={styles.ruleActionButton}
            onPress={() => {
              router.push({
                pathname: '/automation-editor',
                params: { automationId: rule.automationId },
              });
            }}
          >
            <Text style={styles.ruleActionText}>Edit</Text>
          </Pressable>
        )}
        <Pressable style={styles.ruleActionButton} onPress={onToggleExpanded}>
          <Text style={styles.ruleActionText}>Runs {expanded ? '▴' : '▾'}</Text>
        </Pressable>
        <Pressable
          style={styles.ruleActionButton}
          disabled={remove.isPending}
          onPress={confirmDelete}
        >
          <Text style={styles.ruleActionDangerText}>Delete</Text>
        </Pressable>
      </View>

      {expanded && <RunHistory automationId={rule.automationId} />}
    </View>
  );
}

/**
 * Run history for one rule (§3, §9 decision 8) — shows SKIPPED and
 * REFUSED runs alongside successes, deliberately: "why didn't my rule
 * fire" is the question this exists to answer, and a list of successes
 * alone cannot distinguish "the engine never saw the event" from "it saw
 * it and the condition said no".
 */
function RunHistory({ automationId }: { readonly automationId: string }) {
  const runs = useQuery({
    queryKey: automationRunsQueryKey(automationId),
    queryFn: async () => wire(await apiClient.automation.runs.query({ automationId, limit: 50 })),
    staleTime: 5_000,
  });

  if (runs.isPending) {
    return <ActivityIndicator style={styles.runsLoading} color={colors.accent.hex} />;
  }
  if (runs.isError) {
    return (
      <Text style={styles.runsError}>
        {apiErrorOf(runs.error)?.error.message ?? 'Could not load run history.'}
      </Text>
    );
  }
  if (runs.data.length === 0) {
    return (
      <Text style={styles.runsEmpty}>
        This rule has not run yet. A run is recorded every time its trigger fires — including when
        the condition does not match.
      </Text>
    );
  }

  return (
    <View style={styles.runsList}>
      {runs.data.map((run) => (
        <RunRow key={run.runId} run={run} />
      ))}
    </View>
  );
}

function RunRow({ run }: { readonly run: AutomationRun }) {
  const outcomes = run.actionResults
    .map((result) => actionOutcomeOf(result))
    .filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null);

  return (
    <View style={styles.runRow}>
      <View style={styles.runTop}>
        <Text style={[styles.runStatus, { color: statusColor(run.status) }]}>{run.status}</Text>
        <Text style={styles.runReason} numberOfLines={2}>
          {run.reason === null ? explainStatus(run.status) : explainReason(run.reason)}
          {run.depth > 0 ? ` · ${String(run.depth)} automation hop(s) deep` : ''}
        </Text>
      </View>
      <Text style={styles.runTime}>
        {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
      </Text>
      {outcomes.length > 0 && (
        <View style={styles.runOutcomes}>
          {outcomes.map((outcome, index) => (
            <Text
              key={index}
              style={[
                styles.runOutcome,
                { color: outcome.failed ? colors.danger.hex : colors.success.hex },
              ]}
              numberOfLines={2}
            >
              {outcome.failed ? '✕ ' : '✓ '}
              <Text style={styles.runOutcomeLabel}>{outcome.label}</Text>
              {outcome.error !== null && (
                <Text style={styles.runOutcomeError}> — {outcome.error}</Text>
              )}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
    marginLeft: 20,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  titleColumn: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  newRuleButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 2,
  },
  newRuleButtonText: {
    color: colors.accentInk.hex,
    fontSize: 12,
    fontWeight: '700',
  },
  loading: {
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    paddingHorizontal: 20,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingHorizontal: 20,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 10,
  },
  loadMoreButton: {
    alignSelf: 'center',
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  loadMoreText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  ruleCard: {
    borderRadius: radiusCard,
    borderWidth: 1,
    borderColor: colors.line.hex,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 12,
    gap: 8,
  },
  ruleCardDisabled: {
    borderColor: colors.line.hex + '80',
  },
  ruleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    height: 7,
    width: 7,
    borderRadius: 3.5,
  },
  ruleName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  brokenBadge: {
    backgroundColor: colors.danger.hex + '1A',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  brokenBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.danger.hex,
  },
  ruleSummary: {
    fontSize: 12,
    lineHeight: 17,
  },
  ruleSummaryFaint: {
    color: colors.inkFaint.hex,
  },
  ruleSummaryMuted: {
    color: colors.inkMuted.hex,
  },
  ruleActions: {
    flexDirection: 'row',
    gap: 14,
  },
  ruleActionButton: {
    paddingVertical: 2,
  },
  ruleActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  ruleActionDangerText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  runsLoading: {
    marginTop: 4,
  },
  runsError: {
    fontSize: 12,
    color: colors.danger.hex,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
  },
  runsEmpty: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
  },
  runsList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
    gap: 8,
  },
  runRow: {
    gap: 2,
  },
  runTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  runStatus: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  runReason: {
    flex: 1,
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  runTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  runOutcomes: {
    marginTop: 2,
    marginLeft: 8,
    gap: 1,
  },
  runOutcome: {
    fontSize: 12,
  },
  runOutcomeLabel: {
    color: colors.inkFaint.hex,
  },
  runOutcomeError: {
    color: colors.danger.hex,
  },
});
