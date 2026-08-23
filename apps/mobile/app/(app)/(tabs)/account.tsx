import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../../src/lib/app-session.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { ProfileSection } from '../../../src/lib/profile-section.js';
import { WorkingHoursSection } from '../../../src/lib/working-hours-section.js';
import { PasskeySection } from '../../../src/lib/passkey-section.js';
import { TotpSection } from '../../../src/lib/totp-section.js';
import { ConnectedAccountsSection } from '../../../src/lib/connected-accounts-section.js';
import { SessionsSection } from '../../../src/lib/sessions-section.js';
import { PushNotificationsSection } from '../../../src/lib/push-notifications-section.js';
import { RingtoneSection } from '../../../src/lib/ringtone-section.js';
import { ExportDataSection } from '../../../src/lib/export-data-section.js';

/**
 * The Account tab — the one place `apps/web`'s sidebar footer (`OrgSwitcher`
 * + the account dropdown, `shell.tsx`) puts "which org am I in", "switch
 * it", and "sign out"; nothing here had a home before the navigation-shell
 * increment (see `_layout.tsx`'s own header for why a tab bar exists now at
 * all) that first added this screen.
 *
 * **Growing toward parity with web's much larger `account-page.tsx`** (656
 * lines: profile editing, connected accounts, TOTP, device/session
 * inventory, DSAR export) — a real device video review asked for it by
 * name, and each section below documents its own porting notes. Still
 * ahead, in order: TOTP (needs a new QR-rendering dependency), profile
 * editing plus working hours/out-of-office, and self-serve DSAR export.
 *
 * "Switch organization" pushes `/org-picker` — the SAME screen
 * `(app)/_layout.tsx`'s gate already redirects to when no valid org is
 * remembered, now also reachable on demand. That screen already handles the
 * "no memberships" case, already calls `session.selectOrg` +
 * `router.replace('/home')` on pick, and already lives outside `(app)/` for
 * the gate-loop reason its own header documents — nothing about it needed
 * to change to be reachable voluntarily as well as by force.
 */
export default function Account() {
  const orgId = useSession((state) => state.orgId);

  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
  });
  const currentOrg = orgs.data?.find((org) => org.orgId === orgId);
  const paddingTop = useTopInset();

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Account</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Organization</Text>
        <Text style={styles.orgName}>{currentOrg?.name ?? '—'}</Text>
        {currentOrg !== undefined && <Text style={styles.orgRole}>{currentOrg.role}</Text>}
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            router.push('/org-picker');
          }}
        >
          <Text style={styles.secondaryButtonText}>Switch organization</Text>
        </Pressable>
        {/* Always shown, not gated on a capability read here — the roster
            itself is `member:read` (every role), and `org-settings.tsx`'s
            own controls each gate on their own capability, the same
            "the UI never re-derives authorization" argument CLAUDE.md's
            §8.2 makes everywhere else. */}
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            router.push('/org-settings');
          }}
        >
          <Text style={styles.secondaryButtonText}>Manage organization</Text>
        </Pressable>
      </View>

      <ProfileSection />
      <WorkingHoursSection />
      <PasskeySection />
      <TotpSection />
      <ConnectedAccountsSection />
      <SessionsSection />
      <PushNotificationsSection />
      <RingtoneSection />
      <ExportDataSection />

      <Pressable
        style={styles.button}
        onPress={() => {
          void session.signOut();
        }}
      >
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  orgName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  orgRole: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.inkMuted.hex,
    textTransform: 'capitalize',
  },
  button: {
    borderRadius: radiusCard + 2,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.danger.hex + '40',
    backgroundColor: colors.danger.hex + '08',
    marginTop: 8,
  },
  buttonText: {
    color: colors.danger.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + "80",
    marginTop: 4,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
