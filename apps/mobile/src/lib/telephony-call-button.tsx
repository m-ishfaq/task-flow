import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { ORG_DETAIL_QUERY_KEY } from './org-settings.js';
import { CALLS_QUERY_KEY, PHONE_NUMBERS_QUERY_KEY, SPEND_CURRENT_QUERY_KEY } from './telephony.js';

/**
 * Click-to-call, wherever a phone number is already on screen — the mobile
 * counterpart of `apps/web/src/features/telephony/call-button.tsx`. Named
 * `TelephonyCallButton`, not `CallButton`, because this app already has one:
 * `call-button.tsx`'s `CallButton` is Phase 13's in-app WebRTC calling
 * (`session.service.ts`), a completely different system on a different tRPC
 * namespace (`rtc.*` vs `telephony.*`) that happens to share the word
 * "call." Web keeps the two apart with a directory boundary
 * (`features/rtc/call-button.tsx` vs `features/telephony/call-button.tsx`);
 * this app is flat under `src/lib/`, so the name itself has to do that job.
 *
 * ## It hides itself, and that is new (Phase 15 §1)
 *
 * `call:place` used to be a Member role default, so "render for everyone
 * and let the server answer" was correct — nobody would ever actually be
 * refused. It is now an individually granted permission
 * (`authz.member_grants`), so a Member who does not hold it would
 * otherwise see a live "Call" button on the call log and every SMS thread
 * and get a FORBIDDEN alert every time — see
 * `apps/web/src/features/telephony/call-button.tsx`'s own doc comment for
 * the identical fix on the other platform. `capabilities.placeCalls` is
 * the same server-computed boolean `calls.tsx` reads
 * (`tenancy.orgs.get`), so this still is not re-deriving `can()`. Renders
 * `null` while that capability is loading or absent.
 *
 * The ONE thing checked locally beyond that is whether the org owns a
 * number at all — not a permission, a precondition with a specific remedy
 * ("buy one"), and a FORBIDDEN-shaped error would describe it wrongly.
 *
 * ## Never records
 *
 * Recording is a decision with legal weight in several jurisdictions
 * (`packages/telephony`'s consent table), and a button whose caption is
 * "Call" must not be the thing that starts it — the dialler on the Calls
 * tab has the explicit toggle for that.
 */
export function TelephonyCallButton({
  to,
  label = 'Call',
  variant = 'ghost',
}: {
  /** Destination in E.164. A blank value disables the button. */
  readonly to: string;
  readonly label?: string;
  readonly variant?: 'primary' | 'ghost';
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const org = useQuery({
    queryKey: ORG_DETAIL_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.orgs.get.query()),
  });
  const canPlaceCalls = org.data?.capabilities.placeCalls === true;
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
    enabled: canPlaceCalls,
  });

  const from = numbers.data?.[0]?.phoneNumberId ?? '';
  const [justPlaced, setJustPlaced] = useState(false);

  const place = useMutation({
    mutationFn: () =>
      apiClient.telephony.calls.place.mutate({ to, fromPhoneNumberId: from, record: false }),
    onSuccess: async () => {
      setJustPlaced(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CALLS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SPEND_CURRENT_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      Alert.alert('Call not placed', apiErrorOf(error)?.error.message ?? `Could not call ${to}.`);
    },
  });

  const noNumber = !numbers.isPending && from === '';

  // Renders nothing until the capability is known, and nothing at all for a
  // caller who does not hold `call:place` — see the doc comment above.
  if (!canPlaceCalls) return null;

  return (
    <Pressable
      style={[
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : styles.buttonGhost,
        (place.isPending || to === '' || noNumber) && styles.buttonDisabled,
      ]}
      disabled={place.isPending || to === '' || noNumber}
      onPress={() => {
        setJustPlaced(false);
        place.mutate();
      }}
    >
      {place.isPending ? (
        <ActivityIndicator
          color={variant === 'primary' ? colors.accentInk.hex : colors.accent.hex}
        />
      ) : (
        <Text
          style={variant === 'primary' ? styles.buttonPrimaryText : styles.buttonGhostText}
          numberOfLines={1}
        >
          {justPlaced ? 'Calling…' : noNumber ? 'No number' : `📞 ${label}`}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonGhost: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  buttonGhostText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  buttonPrimary: {
    backgroundColor: colors.accent.hex,
  },
  buttonPrimaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accentInk.hex,
  },
});
