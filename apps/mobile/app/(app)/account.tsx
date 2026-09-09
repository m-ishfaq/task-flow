import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../../src/lib/app-session.js';
import { useSession } from '../../src/lib/use-session.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { ProfileSection } from '../../src/lib/profile-section.js';
import { WorkingHoursSection } from '../../src/lib/working-hours-section.js';
import { PasskeySection } from '../../src/lib/passkey-section.js';
import { TotpSection } from '../../src/lib/totp-section.js';
import { ConnectedAccountsSection } from '../../src/lib/connected-accounts-section.js';
import { SessionsSection } from '../../src/lib/sessions-section.js';
import { NotificationPreferencesSection } from '../../src/lib/notification-prefs-section.js';
import { PushNotificationsSection } from '../../src/lib/push-notifications-section.js';
import { RingtoneSection } from '../../src/lib/ringtone-section.js';
import { ExportDataSection } from '../../src/lib/export-data-section.js';
import { ORG_DETAIL_QUERY_KEY } from '../../src/lib/org-settings.js';

/**
 * Account — the one place `apps/web`'s sidebar footer (`OrgSwitcher` + the
 * account dropdown, `shell.tsx`) puts "which org am I in", "switch it", and
 * "sign out". A sibling of `org-settings.tsx` under `(app)/`, pushed from
 * `top-bar.tsx`'s icon rather than a `(tabs)/_layout.tsx` tab — it lived
 * there originally, moved out once a live report asked for two more real
 * tab destinations (Docs, Automations) that `Tabs` has no room for on a
 * phone-width bar without something else giving up its slot first.
 * Account was the one existing tab nothing else routes to mid-task the way
 * a card or a channel does, so it is the one screen that loses nothing by
 * becoming a single tap from a fixed icon instead of a swipeable
 * destination — see `top-bar.tsx`'s own header for the fuller argument.
 * Nothing about the screen's own content changed in the move; it gained
 * only the back button every other pushed screen under `(app)/` already
 * draws, since it is no longer a tab's own root with nowhere to return to.
 *
 * **The org card at the top of the Organization section IS the switcher —
 * tap it, not a separate button below it.** Raised live: should this be
 * more prominent, and should it be styled like Sign out (danger red)? Red
 * stays where it was: reserved for the one action on this screen that
 * actually ends the session, and switching organizations is neither
 * destructive nor rare for anyone belonging to more than one — coloring it
 * like a warning would misstate what it does. What DID change is
 * prominence: the current org's own name/role display is now the tappable
 * element, in the app's accent color, first in the section — pushing
 * `/org-picker`, the SAME screen `(app)/_layout.tsx`'s gate already
 * redirects to when no valid org is remembered, now also reachable on
 * demand. That screen already handles the "no memberships" case, already
 * calls `session.selectOrg` + `router.replace('/home')` on pick, and
 * already lives outside `(app)/` for the gate-loop reason its own header
 * documents — nothing about it needed to change to be reachable
 * voluntarily as well as by force.
 *
 * **"People" joined "Manage organization" and "Automations" as a third
 * link here** the same pass that moved `people.tsx` off the tab bar to
 * make room for Docs — see `(tabs)/_layout.tsx`'s own header for why
 * People was the tab that gave up its slot.
 */
export default function Account() {
  const orgId = useSession((state) => state.orgId);
  const queryClient = useQueryClient();

  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
  });
  const currentOrg = orgs.data?.find((org) => org.orgId === orgId);
  const paddingTop = useTopInset();

  /* Gates the Automations and Insights links below — `automation:manage`/
     `analytics:read` — the same `capabilities` object `org-settings.tsx`
     already reads from this identical route (Phase 15 §1's sweep:
     Automations rendered with NO gate at all, and Insights used a
     hardcoded `role === 'owner' || role === 'admin'` string comparison —
     the exact inline-role-comparison pattern `packages/policy/src/roles.ts`'s
     own header calls out as a lint error everywhere outside
     `packages/policy`, just not caught here because nothing in this app
     lints for it). `analytics:read` is still Admin-and-Owner-only by role
     alone; `automation:manage` joined `GRANTABLE_PERMISSIONS` in Wave 2, but
     this screen only ever needed the ONE permission that gates the rules
     screen it links to (`automations.tsx` has no webhook/integration/API
     token UI — that is web-only) — `manageAutomations` specifically, not an
     "any of" the four automation permissions the web sidebar now checks. */
  const capabilities = useQuery({
    queryKey: ORG_DETAIL_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
  }).data?.capabilities;

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
      <Text style={styles.title}>Account</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Organization</Text>
        {/* The current org IS the switcher, tap-to-open — not a name
            display with a separate "Switch organization" button below it.
            Switching is a normal, frequent, non-destructive action for
            anyone in more than one org, so it gets the opposite visual
            treatment from Sign out below: the most prominent element in
            this section, in the app's own accent color, never danger red —
            red is reserved for the one action here that actually ends the
            session. Placing it first and making the whole row tappable is
            what "easier to reach" means for an action nobody should have
            to hesitate before pressing. */}
        <Pressable
          style={styles.orgSwitchCard}
          onPress={() => {
            router.push('/org-picker');
          }}
        >
          <View style={styles.orgSwitchText}>
            <Text style={styles.orgName}>{currentOrg?.name ?? '—'}</Text>
            {currentOrg !== undefined && <Text style={styles.orgRole}>{currentOrg.role}</Text>}
          </View>
          <Text style={styles.orgSwitchAction}>Switch ›</Text>
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
        {/* `member:read` is `ORG_LEVEL_PERMISSIONS` (packages/policy/src/
            permissions.ts) — a Guest's tuples can never satisfy it, so the
            route floor refuses with a plain role-only FORBIDDEN before the
            handler runs. This comment used to claim the opposite ("floored
            on the server, not a check here" — an empty list for a caller
            who cannot read it) and that was wrong: a Guest tapping this link
            landed on a raw error screen, not an empty directory. Gated the
            identical way Automations/Insights already are below, rather
            than leaving the one remaining ungated entry point. */}
        {capabilities?.viewDirectory === true && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              router.push('/people');
            }}
          >
            <Text style={styles.secondaryButtonText}>People</Text>
          </Pressable>
        )}
        {/* `automation:manage` — Admin/Owner by role, or an individual
            grant (Wave 2). This hides entirely for anyone with neither,
            rather than showing a link that always lands on FORBIDDEN
            (Phase 15 §1's sweep). */}
        {capabilities?.manageAutomations === true && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              router.push('/automations');
            }}
          >
            <Text style={styles.secondaryButtonText}>Automations</Text>
          </Pressable>
        )}
        {/* `analytics:read`, same shape as Automations above. Reads the
            real capability now rather than a hardcoded role string. */}
        {capabilities?.viewAnalytics === true && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              router.push('/insights');
            }}
          >
            <Text style={styles.secondaryButtonText}>Insights</Text>
          </Pressable>
        )}
      </View>

      <ProfileSection />
      <WorkingHoursSection />
      <PasskeySection />
      <TotpSection />
      <ConnectedAccountsSection />
      <SessionsSection />
      <NotificationPreferencesSection />
      <PushNotificationsSection />
      <RingtoneSection />
      <ExportDataSection />

      {/* queryClient.clear() after signOut() — session.signOut() only resets
          the session store (tokens, orgId); the QueryClient is a
          module-level singleton that outlives it. Without this, a second
          person signing in on the same device sees the FIRST person's cached
          query results (MY_TASKS_QUERY_KEY has no user/org scoping, and it
          is not the only such key) rendered instantly on mount, before any
          request the new session's auth would actually refuse ever fires —
          found live, testing account switching. */}
      <Pressable
        style={styles.button}
        onPress={() => {
          void session.signOut().then(() => {
            queryClient.clear();
          });
        }}
      >
        <Text style={[styles.buttonText, { marginBottom: 12 }]}>Sign out</Text>
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
    paddingBottom: 80,
    gap: 24,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: -12,
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
  orgSwitchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderRadius: radiusCard + 2,
    borderWidth: 1,
    borderColor: colors.accent.hex + '40',
    backgroundColor: colors.accent.hex + '0C',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  orgSwitchText: {
    flex: 1,
    gap: 1,
  },
  orgSwitchAction: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent.hex,
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
    borderColor: colors.line.hex + '80',
    marginTop: 4,
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
});
