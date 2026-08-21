import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { useStepUp } from './use-step-up.js';
import { StepUpSheet } from './step-up-sheet.js';
import {
  OAUTH_PROVIDER_LABEL,
  OAUTH_REDIRECT_URL,
  parseOAuthRedirect,
  type OAuthProvider,
} from './oauth.js';

const CONNECTED_QUERY_KEY = ['auth.oauth.listConnected'] as const;

/**
 * Connected accounts (Google/GitHub) — closes the gap `apps/mobile/README.md`
 * names: web's `connected-accounts-section.tsx`, ported. Listing and
 * unlinking use the CHANNEL-AGNOSTIC `auth.oauth.*` routes (`listConnected`,
 * `unlink`) — the same routes the browser calls, since neither reads or
 * writes anything channel-specific. Linking is the one operation that is
 * channel-specific (the redirect must land back in THIS app, not a browser
 * tab), so it goes through `auth.native.oauth.startLink`/`callback` —
 * `apps/api/src/identity/router.ts`'s own header on that route explains why
 * it did not exist before this screen needed it, and why it required no new
 * SERVICE logic, only the route.
 *
 * The link flow mirrors `(auth)/sign-in.tsx`'s OAuth mutation almost
 * exactly (`openAuthSessionAsync` + `parseOAuthRedirect`) — the one
 * difference is `onSuccess`: sign-in adopts a session; this never does,
 * because a `{ kind: 'linked' }` result carries no tokens to adopt, only a
 * confirmation that the org's existing session just gained a second way in.
 *
 * Every mutation here is `stepUp: true` server-side — see `use-step-up.ts`'s
 * own header — so both `link` and `unlink` route their `onError` through
 * this section's own `guard`.
 */
export function ConnectedAccountsSection() {
  const queryClient = useQueryClient();
  const { guard, pending, confirm, cancel } = useStepUp();

  const providers = useQuery({
    queryKey: ['auth.native.oauth.providers'],
    queryFn: () => apiClient.auth.native.oauth.providers.query(),
  });
  const connected = useQuery({
    queryKey: CONNECTED_QUERY_KEY,
    queryFn: async () => wire(await apiClient.auth.oauth.listConnected.query()),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: CONNECTED_QUERY_KEY });
  };

  const link = useMutation({
    mutationFn: async (provider: OAuthProvider) => {
      const { authorizationUrl } = await apiClient.auth.native.oauth.startLink.mutate({
        provider,
      });
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, OAUTH_REDIRECT_URL);
      if (result.type !== 'success') return null;

      const parsed = parseOAuthRedirect(result.url);
      if (parsed === null) {
        throw new Error('The provider did not return a valid response.');
      }
      return apiClient.auth.native.oauth.callback.mutate({ provider, ...parsed });
    },
    onSuccess: refresh,
  });
  // Closes over `provider` directly rather than reading it back off
  // `link.variables` — `mutate()`'s own per-call `onError` is what lets the
  // step-up retry name the exact provider that was being linked, with no
  // assertion needed to un-optional a `variables` field that has not
  // settled yet the first time this fires.
  const runLink = (provider: OAuthProvider): void => {
    link.mutate(provider, {
      onError: (error) => {
        guard(error, () => {
          runLink(provider);
        });
      },
    });
  };

  const unlink = useMutation({
    mutationFn: (provider: OAuthProvider) => apiClient.auth.oauth.unlink.mutate({ provider }),
    onSuccess: refresh,
  });
  const runUnlink = (provider: OAuthProvider): void => {
    unlink.mutate(provider, {
      onError: (error) => {
        guard(error, () => {
          runUnlink(provider);
        });
      },
    });
  };

  const linkedProviders = new Set((connected.data ?? []).map((row) => row.provider));
  const linkable = (['google', 'github'] as const).filter(
    (provider) => providers.data?.[provider] === true,
  );

  if (linkable.length === 0 && (connected.data ?? []).length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Connected accounts</Text>

      {(connected.data ?? []).map((row) => (
        <View key={row.provider} style={styles.row}>
          <View>
            <Text style={styles.rowLabel}>{OAUTH_PROVIDER_LABEL[row.provider]}</Text>
            <Text style={styles.rowMeta}>{row.email}</Text>
          </View>
          <Pressable
            disabled={unlink.isPending}
            onPress={() => {
              runUnlink(row.provider);
            }}
          >
            <Text style={styles.unlinkText}>Unlink</Text>
          </Pressable>
        </View>
      ))}

      {linkable
        .filter((provider) => !linkedProviders.has(provider))
        .map((provider) => (
          <Pressable
            key={provider}
            style={styles.linkButton}
            disabled={link.isPending}
            onPress={() => {
              runLink(provider);
            }}
          >
            {link.isPending && link.variables === provider ? (
              <ActivityIndicator color={colors.ink.hex} />
            ) : (
              <Text style={styles.linkButtonText}>Connect {OAUTH_PROVIDER_LABEL[provider]}</Text>
            )}
          </Pressable>
        ))}

      {(link.isError || unlink.isError) && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(link.error ?? unlink.error)?.error.message ?? 'That could not be completed.'}
        </Text>
      )}

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  rowLabel: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowMeta: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  unlinkText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  linkButton: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  linkButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  error: {
    fontSize: 12,
    color: colors.danger.hex,
  },
});
