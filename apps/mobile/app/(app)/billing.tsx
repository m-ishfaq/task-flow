import { useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { format } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import {
  BILLING_OVERVIEW_QUERY_KEY,
  BILLING_PLANS_QUERY_KEY,
  BILLING_INVOICES_QUERY_KEY,
  formatMoney,
  daysUntil,
  type BillingPlan,
} from '../../src/lib/billing.js';

/**
 * Org billing — ported from `apps/web/src/features/admin/billing-
 * section.tsx`, as its own screen rather than a section on
 * `org-settings.tsx`. `org:billing` answers "what does this org pay",
 * which is a different question from everything on the settings screen
 * ("who is in it and what can they do") — web's single settings page
 * bundles both for density on a wide layout; a phone screen has no such
 * spare room, and the two were already two different `Section`s there.
 * Reached from a "Billing" link at the top of `org-settings.tsx`, always
 * visible for the same reason every control there is (§8.2): a non-owner
 * gets the honest error below, not a hidden link.
 *
 * **Checkout and the customer portal are processor-hosted redirects,
 * exactly as on web** — this screen never collects a card number, and
 * never will, for any processor `PaymentProvider` is ever configured
 * against. Where web navigates the WHOLE page to `result.url` and relies
 * on the browser returning with `?checkout=success` in the address bar,
 * mobile has no address bar to carry that signal — `WebBrowser.
 * openBrowserAsync` (the same `expo-web-browser` module `oauth.ts` uses
 * for sign-in, here in its plain non-auth-session form since a Stripe-
 * hosted page has no `taskflow://` redirect to intercept) opens the URL
 * and its promise resolves the moment the person dismisses that browser
 * view, whichever way they got there. Calling `reconcile` unconditionally
 * on that resolution is a STRONGER signal than web's query parameter: it
 * fires whether the person completed checkout, cancelled, or updated
 * something in the portal, and `reconcile` is idempotent either way — the
 * webhook remains the primary path, this only makes the screen tell the
 * truth immediately without waiting for one.
 *
 * **The plan-switch confirmation is `Alert.alert`, not a custom dialog.**
 * `SwitchPlanDialog` on web exists because "Switch" hides two genuinely
 * different outcomes — an upgrade charges today, a downgrade waits until
 * the period ends — and a two-button alert with the specific wording says
 * exactly as much as the modal did, matching this app's own established
 * use of `Alert.alert` for a real confirm decision (`project-
 * settings.tsx`'s label/status deletes and project archive).
 */
/**
 * Clamped 0-100 usage width, as the `${number}%` string RN's `DimensionValue`
 * wants. String concatenation rather than a template literal — this repo's
 * `restrict-template-expressions` config disallows a bare number inside
 * `${...}`, and `+` is outside that rule's scope; the cast back to
 * `DimensionValue` is honest, since `percent` is always a finite 0-100 number.
 */
function usagePercentWidth(spentCents: number, capCents: number): DimensionValue {
  const percent = Math.min(100, capCents === 0 ? 100 : Math.round((spentCents / capCents) * 100));
  return (String(percent) + '%') as DimensionValue;
}

export default function BillingScreen() {
  const paddingTop = useTopInset();
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState(false);

  const overview = useQuery({
    queryKey: BILLING_OVERVIEW_QUERY_KEY,
    queryFn: async () => wire(await apiClient.billing.overview.query()),
  });
  const plans = useQuery({
    queryKey: BILLING_PLANS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.billing.listPlans.query()),
  });
  const invoices = useQuery({
    queryKey: BILLING_INVOICES_QUERY_KEY,
    queryFn: async () => wire(await apiClient.billing.invoices.query({ limit: 24 })),
  });

  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: BILLING_OVERVIEW_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: BILLING_INVOICES_QUERY_KEY }),
    ]);
  };

  const reconcile = useMutation({
    mutationFn: () => apiClient.billing.reconcile.mutate(),
    onSuccess: refreshAll,
  });

  /**
   * Opens a processor-hosted URL and reconciles once the browser view
   * closes — the one helper both Checkout and the portal share, since
   * both need the identical "sync when the person comes back" behaviour.
   */
  const openAndReconcile = async (url: string): Promise<void> => {
    setOpening(true);
    try {
      await WebBrowser.openBrowserAsync(url);
      await reconcile.mutateAsync();
    } finally {
      setOpening(false);
    }
  };

  const checkout = useMutation({
    mutationFn: (input: { planId: string; interval: 'month' | 'year' }) =>
      apiClient.billing.createCheckoutSession.mutate(input),
    onSuccess: (result) => {
      void openAndReconcile(result.url);
    },
  });

  const change = useMutation({
    mutationFn: (input: { planId: string; interval: 'month' | 'year' }) =>
      apiClient.billing.changePlan.mutate(input),
    onSuccess: refreshAll,
  });

  const cancel = useMutation({
    mutationFn: () => apiClient.billing.cancelPlan.mutate(),
    onSuccess: refreshAll,
  });

  const resume = useMutation({
    mutationFn: () => apiClient.billing.resumePlan.mutate(),
    onSuccess: refreshAll,
  });

  const portal = useMutation({
    mutationFn: () => apiClient.billing.createPortalSession.mutate(),
    onSuccess: (result) => {
      void openAndReconcile(result.url);
    },
  });

  const data = overview.data;
  const sellable = (plans.data ?? []).filter((plan) => plan.prices.length > 0);
  const hasSubscription = data?.hasSubscription ?? false;

  const choosePlan = (plan: BillingPlan): void => {
    const monthly = plan.prices.find((price) => price.interval === 'month');
    const amountCents = monthly?.amountCents ?? 0;

    if (!hasSubscription) {
      checkout.mutate({ planId: plan.id, interval: 'month' });
      return;
    }

    const isUpgrade = amountCents > (data?.currentPriceCents ?? 0);
    const renewsAt = data?.deadline?.kind === 'renews' ? data.deadline.at : null;

    Alert.alert(
      `Switch to ${plan.name}?`,
      isUpgrade
        ? `This takes effect immediately. You will be charged the difference for the rest of the current period, and ${plan.name} becomes available straight away.`
        : `This takes effect ${renewsAt === null ? 'at the end of your current period' : format(new Date(renewsAt), 'd MMM yyyy')}. You keep everything you are paying for until then — nothing is removed today, and there is no charge now.`,
      [
        { text: 'Keep current plan', style: 'cancel' },
        {
          text: isUpgrade ? 'Upgrade now' : 'Schedule change',
          onPress: () => {
            change.mutate({ planId: plan.id, interval: 'month' });
          },
        },
      ],
    );
  };

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
      <Text style={styles.screenTitle}>Billing</Text>

      {overview.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : overview.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(overview.error)?.error.message ?? 'Could not load billing.'}
        </Text>
      ) : data === undefined ? null : (
        <>
          <View style={styles.card}>
            <View style={styles.statusRow}>
              <View style={styles.statusBadge}>
                <Text style={styles.statusBadgeText}>{data.billingStatus}</Text>
              </View>
              <Text style={styles.planName}>{data.planName ?? data.planId ?? 'No plan'}</Text>
            </View>

            {(data.billingStatus === 'active' || data.billingStatus === 'past_due') && (
              <Pressable
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
                disabled={opening}
                onPress={() => {
                  portal.mutate();
                }}
              >
                {portal.isPending || (opening && !checkout.isPending) ? (
                  <ActivityIndicator color={colors.ink.hex} />
                ) : (
                  <Text style={styles.secondaryButtonText}>Manage subscription</Text>
                )}
              </Pressable>
            )}

            {data.billingStatus === 'active' &&
              !data.cancelAtPeriodEnd &&
              data.deadline?.kind === 'renews' && (
                <Pressable
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
                  disabled={cancel.isPending}
                  onPress={() => {
                    cancel.mutate();
                  }}
                >
                  <Text style={styles.secondaryButtonText}>
                    {cancel.isPending ? 'Cancelling…' : 'Cancel at period end'}
                  </Text>
                </Pressable>
              )}

            {(data.cancelAtPeriodEnd || data.billingStatus === 'canceled') && (
              <Pressable
                style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed]}
                disabled={resume.isPending}
                onPress={() => {
                  resume.mutate();
                }}
              >
                {resume.isPending ? (
                  <ActivityIndicator color={colors.accentInk.hex} />
                ) : (
                  <Text style={styles.saveButtonText}>Resume subscription</Text>
                )}
              </Pressable>
            )}

            {reconcile.isPending && (
              <Text style={styles.sectionHint}>Confirming your payment…</Text>
            )}

            {data.deadline !== null && (
              <Text
                style={
                  data.deadline.kind === 'grace_ends' || data.deadline.kind === 'cancels'
                    ? styles.deadlineDanger
                    : styles.sectionHint
                }
              >
                {data.deadline.kind === 'trial_ends' && 'Trial ends '}
                {data.deadline.kind === 'grace_ends' && 'Access pauses '}
                {data.deadline.kind === 'renews' && 'Renews '}
                {data.deadline.kind === 'cancels' && 'Your subscription ends '}
                {data.deadline.kind === 'plan_changes' &&
                  `Moves to ${data.deadline.planId ?? 'another plan'} `}
                {format(new Date(data.deadline.at), 'd MMM yyyy')}
                {daysUntil(data.deadline.at) !== null &&
                  ` — ${String(daysUntil(data.deadline.at))} days`}
                .
              </Text>
            )}

            {data.billingStatus === 'trialing' && data.deadline === null && (
              <Text style={styles.sectionHint}>
                On trial, with no end date set. Choose a plan whenever you are ready.
              </Text>
            )}

            {data.billingStatus === 'past_due' && data.billingGraceEndsAt !== null && (
              <Text style={styles.deadlineDanger}>
                A recent payment failed. Update your payment method by{' '}
                {format(new Date(data.billingGraceEndsAt), 'd MMM yyyy')}, or access will pause.
              </Text>
            )}

            {data.cancelAtPeriodEnd && data.billingStatus !== 'canceled' && (
              <Text style={styles.sectionHint}>
                Nothing changes until then — you keep {data.planName ?? 'your plan'} and every
                feature it includes, and you will not be charged again.
              </Text>
            )}

            {data.billingStatus === 'canceled' && (
              <Text style={styles.deadlineDanger}>
                This organization's subscription has ended. Choose a plan to restore access.
              </Text>
            )}

            {data.billingContact !== null && (
              <Text style={styles.contactHint}>
                Billing is managed by {data.billingContact.name ?? data.billingContact.email}
                {data.billingContact.name !== null ? ` (${data.billingContact.email})` : ''}.
              </Text>
            )}
          </View>

          {data.features.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Included in your plan</Text>
              {data.features.map((feature) => (
                <Text key={feature.flagName} style={styles.featureLine}>
                  ✓ {feature.description}
                </Text>
              ))}
            </View>
          )}

          {data.usage.telephonyCapCents !== null && (
            <View style={styles.card}>
              <View style={styles.usageRow}>
                <Text style={styles.cardTitle}>Voice & messaging, last 30 days</Text>
                <Text style={styles.sectionHint}>
                  {formatMoney(data.usage.telephonySpentCents)} of{' '}
                  {formatMoney(data.usage.telephonyCapCents)}
                </Text>
              </View>
              <View style={styles.usageTrack}>
                <View
                  style={[
                    styles.usageFill,
                    data.usage.telephonySpentCents >= data.usage.telephonyCapCents
                      ? styles.usageFillOver
                      : null,
                    {
                      width: usagePercentWidth(
                        data.usage.telephonySpentCents,
                        data.usage.telephonyCapCents,
                      ),
                    },
                  ]}
                />
              </View>
            </View>
          )}

          {invoices.data !== undefined && invoices.data.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Invoices</Text>
              {invoices.data.map((invoice) => (
                <View key={invoice.providerInvoiceId} style={styles.invoiceRow}>
                  <Text style={styles.invoiceDate}>
                    {format(new Date(invoice.issuedAt), 'd MMM yyyy')}
                  </Text>
                  <Text style={styles.invoiceNumber} numberOfLines={1}>
                    {invoice.number ?? invoice.providerInvoiceId}
                  </Text>
                  <Text style={styles.rowCount}>{invoice.status}</Text>
                  <Text style={styles.invoiceAmount}>
                    {formatMoney(invoice.amountDueCents, invoice.currency)}
                  </Text>
                  {invoice.hostedInvoiceUrl !== null && (
                    <Pressable
                      onPress={() => {
                        void Linking.openURL(invoice.hostedInvoiceUrl ?? '');
                      }}
                    >
                      <Text style={styles.editText}>View</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Plans</Text>

            {plans.isPending && <ActivityIndicator color={colors.accent.hex} />}
            {plans.isError && (
              <Text style={styles.sectionError} accessibilityRole="alert">
                {apiErrorOf(plans.error)?.error.message ?? "Couldn't load plans."}
              </Text>
            )}
            {plans.data !== undefined && sellable.length === 0 && (
              <Text style={styles.sectionHint}>
                No plans are available for purchase yet. Nothing is wrong with your account — the
                catalog has not been set up.
              </Text>
            )}

            {sellable.map((plan) => {
              const monthly = plan.prices.find((price) => price.interval === 'month');
              const current = plan.id === data.planId;

              return (
                <View key={plan.id} style={styles.planRow}>
                  <View style={styles.planInfo}>
                    <Text style={styles.planRowName}>
                      {plan.name}
                      {current ? ' · current' : ''}
                    </Text>
                    {plan.description !== null && (
                      <Text style={styles.sectionHint}>{plan.description}</Text>
                    )}
                    <Text style={styles.planPrice}>
                      {plan.prices
                        .map(
                          (price) =>
                            `${formatMoney(price.amountCents, price.currency)}/${price.interval}`,
                        )
                        .join(' · ')}
                    </Text>
                    {plan.features.length === 0 ? (
                      <Text style={styles.rowCount}>Core work management only</Text>
                    ) : (
                      plan.features.map((feature) => (
                        <Text key={feature} style={styles.rowCount}>
                          ✓ {feature}
                        </Text>
                      ))
                    )}
                  </View>
                  <Pressable
                    style={({ pressed }) => [
                      current ? styles.secondaryButton : styles.saveButton,
                      pressed && (current ? styles.buttonPressed : styles.saveButtonPressed),
                    ]}
                    disabled={
                      current ||
                      checkout.isPending ||
                      change.isPending ||
                      opening ||
                      monthly === undefined
                    }
                    onPress={() => {
                      choosePlan(plan);
                    }}
                  >
                    {checkout.isPending || change.isPending || opening ? (
                      <ActivityIndicator color={current ? colors.ink.hex : colors.accentInk.hex} />
                    ) : (
                      <Text style={current ? styles.secondaryButtonText : styles.saveButtonText}>
                        {current ? 'Current' : hasSubscription ? 'Switch' : 'Choose'}
                      </Text>
                    )}
                  </Pressable>
                </View>
              );
            })}
          </View>
        </>
      )}

      {change.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(change.error)?.error.message ?? 'Could not switch plans.'}
        </Text>
      )}
      {cancel.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(cancel.error)?.error.message ?? 'Could not cancel.'}
        </Text>
      )}
      {resume.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(resume.error)?.error.message ?? 'Could not resume.'}
        </Text>
      )}
      {checkout.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(checkout.error)?.error.message ?? 'Could not start checkout.'}
        </Text>
      )}
      {portal.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(portal.error)?.error.message ?? 'Could not open the subscription portal.'}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 12,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  card: {
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 16,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  planName: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  saveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard + 2,
    paddingVertical: 10,
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  saveButtonPressed: {
    opacity: 0.8,
  },
  deadlineDanger: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  contactHint: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  featureLine: {
    fontSize: 12,
    color: colors.ink.hex,
  },
  usageRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  usageTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSunken.hex,
    overflow: 'hidden',
  },
  usageFill: {
    height: '100%',
    backgroundColor: colors.accent.hex,
    borderRadius: 3,
  },
  usageFillOver: {
    backgroundColor: colors.danger.hex,
  },
  invoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  invoiceDate: {
    fontSize: 11,
    color: colors.inkMuted.hex,
    width: 72,
  },
  invoiceNumber: {
    flex: 1,
    fontSize: 12,
    color: colors.ink.hex,
  },
  rowCount: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  invoiceAmount: {
    fontSize: 12,
    color: colors.ink.hex,
  },
  editText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex + '60',
  },
  planInfo: {
    flex: 1,
    gap: 2,
  },
  planRowName: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  planPrice: {
    fontSize: 13,
    color: colors.ink.hex,
  },
});
