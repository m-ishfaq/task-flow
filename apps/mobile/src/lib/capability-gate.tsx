import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { ORG_DETAIL_QUERY_KEY, type SettingsCapabilities } from './org-settings.js';

/**
 * The mobile counterpart of `apps/web/src/components/capability-gate.tsx`'s
 * `CapabilityGate` — renders `children` when the caller holds `capability`,
 * and a plain "not for your role" screen otherwise.
 *
 * Web has TWO layers for this: a nav link that hides itself, and a route
 * wrapper for anyone who reaches the page anyway (a stale link, a deep
 * link, the back button). Before this component, mobile only ever had the
 * first layer — `account.tsx` hides the Automations/Insights/Billing
 * links, but the screens themselves (`automations.tsx`, `insights.tsx`,
 * `billing.tsx`) had no equivalent of the second, so a deep link still
 * landed on a raw FORBIDDEN with a request-id reference (Phase 15 §1's
 * sweep). This is that second layer, built once rather than duplicated
 * per screen.
 *
 * Same cosmetic-gate caveat as web's version: every route behind this still
 * declares its own `permission` and the server re-resolves it on every
 * request, so a stale or wrong capability snapshot here costs a
 * wrongly-shown "not for your role" screen, never wrongly-granted access.
 */
export function CapabilityGate({
  capability,
  children,
}: {
  readonly capability: keyof SettingsCapabilities;
  readonly children: React.ReactNode;
}): React.JSX.Element | null {
  const org = useQuery({
    queryKey: ORG_DETAIL_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
  });

  // Undefined (not yet loaded) renders nothing, same as web's version — a
  // flash of "not for your role" immediately replaced by the real screen
  // is worse than a brief blank beat.
  if (org.data === undefined) return null;

  if (org.data.capabilities[capability]) return <>{children}</>;

  return <NotForYourRole />;
}

function NotForYourRole(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>This isn&apos;t part of your role</Text>
      <Text style={styles.body}>
        An admin or owner can grant you access, or you can ask them to make this change for you.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: colors.surface.hex,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    textAlign: 'center',
  },
  body: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
});
