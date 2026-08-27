import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { useStepUp } from '../../../src/lib/use-step-up.js';
import { StepUpSheet } from '../../../src/lib/step-up-sheet.js';
import { TelephonyCallButton } from '../../../src/lib/telephony-call-button.js';
import { TelephonyContactPicker } from '../../../src/lib/telephony-contact-picker.js';
import {
  CALLS_QUERY_KEY,
  MESSAGE_THREADS_QUERY_KEY,
  PHONE_NUMBERS_QUERY_KEY,
  SPEND_CURRENT_QUERY_KEY,
  SPEND_KIND_LABEL,
  callRecordingsQueryKey,
  callStatusLabel,
  callTranscriptQueryKey,
  durationLabel,
  spendReportQueryKey,
  threadMessagesQueryKey,
  type AvailableNumber,
  type CallRecord,
} from '../../../src/lib/telephony.js';

/**
 * Voice & Messaging — the mobile counterpart of `apps/web/src/features/
 * telephony/telephony-page.tsx` (`/calls`), a real, separate feature this
 * app's own README has twice named as never-ported: "Phase 7's telephony
 * client has never been ported to `apps/mobile` at all." This closes that
 * gap. A 5th bottom tab, not a link off another screen — web treats
 * `/calls` as a sidebar-level destination, the same tier as Chat and Work,
 * and `(tabs)/_layout.tsx`'s own header already names how this bar grows:
 * "Docs/People join this bar as their own waves ship real screens."
 *
 * ## PSTN telephony, not this app's own in-app calling
 *
 * `telephony.*` (Twilio, real phone numbers, real carrier calls and SMS) is
 * a completely different system from `rtc.*` (Phase 13's in-app WebRTC
 * voice, already built — `call-surface.tsx`, `use-call.ts`). The two share
 * the word "call" and nothing else; `telephony-call-button.tsx`'s own
 * header explains why this screen's click-to-call is a differently-named
 * component from the one Chat already has, rather than the same one reused.
 *
 * ## Four tabs over one org-scoped resource, a pill strip rather than
 * nested routes
 *
 * Web uses a search param so the open tab is a shareable link
 * (`settings-page.tsx`'s own pattern). This app has no URL to carry that,
 * so it is local state instead — the same simplification `org-settings.tsx`
 * already makes for its own sections.
 *
 * Per CLAUDE.md §8.2, nothing here re-derives authorization: every control
 * renders unconditionally, and a caller without the permission gets a real
 * FORBIDDEN from the server — `phoneNumber:read`/`call:read`/`sms:read`
 * cover MEMBER for three tabs; Spend's itemized report needs
 * `recording:read` (Admin), so a member sees "current spend" and a
 * FORBIDDEN on the report below it, exactly as the server's own tiering
 * intends.
 */

const TABS = [
  { id: 'calls', label: 'Calls' },
  { id: 'numbers', label: 'Numbers' },
  { id: 'messages', label: 'Messages' },
  { id: 'spend', label: 'Spend' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function CallsScreen() {
  const paddingTop = useTopInset();
  const [tab, setTab] = useState<TabId>('calls');

  return (
    <View style={[styles.container, { paddingTop }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Calls</Text>
      </View>
      <Text style={styles.subtitle}>Phone numbers, calls, SMS, and spend.</Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabStripFrame}
        contentContainerStyle={styles.tabStrip}
      >
        {TABS.map((entry) => (
          <Pressable
            key={entry.id}
            style={[styles.tab, tab === entry.id && styles.tabActive]}
            onPress={() => {
              setTab(entry.id);
            }}
          >
            <Text style={[styles.tabText, tab === entry.id && styles.tabTextActive]}>
              {entry.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {tab === 'calls' && <CallsPanel />}
      {tab === 'numbers' && <NumbersPanel />}
      {tab === 'messages' && <MessagesPanel />}
      {tab === 'spend' && <SpendPanel />}
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Calls — click-to-call and the call log
 * -------------------------------------------------------------------------- */

function CallsPanel() {
  const queryClient = useQueryClient();
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
  });
  const calls = useQuery({
    queryKey: CALLS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.calls.list.query({ limit: 50 })),
  });

  const [to, setTo] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const [record, setRecord] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const owned = numbers.data ?? [];
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (owned[0]?.phoneNumberId ?? '');

  const place = useMutation({
    mutationFn: () =>
      apiClient.telephony.calls.place.mutate({
        to: to.trim(),
        fromPhoneNumberId: activeNumber,
        record,
      }),
    onSuccess: async (result) => {
      setTo('');
      Alert.alert(
        'Call placed',
        result.announcementRequired
          ? 'A recording announcement will play before it starts.'
          : undefined,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CALLS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: SPEND_CURRENT_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      Alert.alert('The call was not placed', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
      <Section label="Place a call">
        <Text style={styles.fieldLabel}>To — pick a person, or type E.164</Text>
        <TelephonyContactPicker value={to} onChange={setTo} />

        {owned.length > 0 && (
          <>
            <Text style={styles.fieldLabel}>From</Text>
            <ChipScroll>
              {owned.map((number) => (
                <Pressable
                  key={number.phoneNumberId}
                  style={[styles.chip, activeNumber === number.phoneNumberId && styles.chipActive]}
                  onPress={() => {
                    setFromPhoneNumberId(number.phoneNumberId);
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      activeNumber === number.phoneNumberId && styles.chipTextActive,
                    ]}
                  >
                    {String(number.e164)}
                  </Text>
                </Pressable>
              ))}
            </ChipScroll>
          </>
        )}

        <View style={styles.recordRow}>
          <Switch value={record} onValueChange={setRecord} />
          <Text style={styles.recordLabel}>Record this call</Text>
        </View>

        {!numbers.isPending && owned.length === 0 && (
          <Text style={styles.warningHint}>No numbers yet — buy one on the Numbers tab first.</Text>
        )}

        <Pressable
          style={[
            styles.primaryButton,
            (place.isPending || activeNumber === '' || to.trim() === '') && styles.buttonDisabled,
          ]}
          disabled={place.isPending || activeNumber === '' || to.trim() === ''}
          onPress={() => {
            place.mutate();
          }}
        >
          {place.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.primaryButtonText}>Call</Text>
          )}
        </Pressable>
      </Section>

      <Section
        label={`Call log${calls.data !== undefined ? ` · ${String(calls.data.length)}` : ''}`}
      >
        {calls.isPending && <ActivityIndicator color={colors.accent.hex} />}
        {calls.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(calls.error)?.error.message ?? 'Could not load the call log.'}
          </Text>
        )}
        {calls.data?.length === 0 && (
          <Text style={styles.emptyHint}>
            Calls you place appear here with their status, duration, and any recording.
          </Text>
        )}
        {calls.data?.map((call) => (
          <CallRow
            key={call.callId}
            call={call}
            expanded={expanded === call.callId}
            onToggle={() => {
              setExpanded((current) => (current === call.callId ? null : call.callId));
            }}
          />
        ))}
      </Section>
    </ScrollView>
  );
}

function CallRow({
  call,
  expanded,
  onToggle,
}: {
  readonly call: CallRecord;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <View style={[styles.rowCard, expanded && styles.rowCardActive]}>
      <Pressable style={styles.rowHeader} onPress={onToggle}>
        <Text style={call.direction === 'outbound' ? styles.directionOut : styles.directionIn}>
          {call.direction === 'outbound' ? '→' : '←'}
        </Text>
        <Text style={styles.rowMono} numberOfLines={1}>
          {String(call.counterparty)}
        </Text>
        {call.durationSeconds !== null && (
          <Text style={styles.rowFaint}>{durationLabel(call.durationSeconds)}</Text>
        )}
        <View style={styles.rowTrailing}>
          {call.recorded && <Text style={styles.recordedTag}>● recorded</Text>}
          <StatusPill status={call.status} />
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.rowBody}>
          {call.startedAt !== null && (
            <Text style={styles.rowBodyMeta}>
              {call.direction === 'outbound' ? 'Placed' : 'Received'}{' '}
              {formatDistanceToNow(new Date(call.startedAt), { addSuffix: true })}
            </Text>
          )}
          {call.recorded ? (
            <CallRecordings callId={call.callId} />
          ) : (
            <Text style={styles.rowBodyMeta}>This call was not recorded.</Text>
          )}
          <View style={styles.rowBodyDivider}>
            <TelephonyCallButton to={String(call.counterparty)} label="Call back" />
          </View>
        </View>
      )}
    </View>
  );
}

function CallRecordings({ callId }: { readonly callId: string }) {
  const { guard, pending, confirm, cancel } = useStepUp();
  const recordings = useQuery({
    queryKey: callRecordingsQueryKey(callId),
    queryFn: async () => wire(await apiClient.telephony.recordings.list.query({ callId })),
  });

  const download = useMutation({
    mutationFn: (recordingId: string) =>
      apiClient.telephony.recordings.download.mutate({ recordingId }),
    onSuccess: (result) => {
      void Linking.openURL(result.url);
    },
    onError: (error, recordingId) => {
      if (
        guard(error, () => {
          download.mutate(recordingId);
        })
      ) {
        return;
      }
      Alert.alert(
        'The recording could not be opened',
        apiErrorOf(error)?.error.message ?? undefined,
      );
    },
  });

  if (recordings.isPending) return <ActivityIndicator color={colors.accent.hex} />;
  if (recordings.isError) {
    return (
      <Text style={styles.errorText}>
        {apiErrorOf(recordings.error)?.error.message ?? 'Could not load recordings.'}
      </Text>
    );
  }
  if (recordings.data.length === 0) {
    return <Text style={styles.rowBodyMeta}>No recording stored yet.</Text>;
  }

  return (
    <View style={styles.recordingsList}>
      {recordings.data.map((recording) => (
        <View key={recording.recordingId} style={styles.recordingRow}>
          <Text style={styles.rowFaint}>
            {recording.status}
            {recording.durationSeconds !== null && ` · ${durationLabel(recording.durationSeconds)}`}
          </Text>
          {recording.status === 'stored' && (
            <Pressable
              disabled={download.isPending}
              onPress={() => {
                download.mutate(recording.recordingId);
              }}
            >
              <Text style={styles.linkText}>Download</Text>
            </Pressable>
          )}
          <Transcript recordingId={recording.recordingId} />
        </View>
      ))}
      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </View>
  );
}

/** Renders nothing on error or while pending — most calls are never
 *  transcribed, and NOT_FOUND is the overwhelmingly common answer; a red
 *  box on every un-transcribed recording would train people to ignore the
 *  one that matters, matching `calls-panel.tsx`'s own `Transcript`. */
function Transcript({ recordingId }: { readonly recordingId: string }) {
  const [open, setOpen] = useState(false);
  const transcript = useQuery({
    queryKey: callTranscriptQueryKey(recordingId),
    queryFn: async () =>
      wire(await apiClient.telephony.recordings.transcript.query({ recordingId })),
    retry: false,
  });

  if (transcript.isPending || transcript.isError) return null;

  return (
    <View style={styles.transcriptBox}>
      <Pressable
        onPress={() => {
          setOpen((current) => !current);
        }}
      >
        <Text style={styles.linkText}>{open ? 'Hide transcript' : 'Show transcript'}</Text>
      </Pressable>
      {open && <Text style={styles.transcriptText}>{transcript.data.text}</Text>}
    </View>
  );
}

function StatusPill({ status }: { readonly status: string }) {
  const tone =
    status === 'in_progress'
      ? styles.pillAccent
      : status === 'completed'
        ? styles.pillSuccess
        : status === 'failed' || status === 'canceled'
          ? styles.pillDanger
          : status === 'busy' || status === 'no_answer'
            ? styles.pillWarning
            : styles.pillNeutral;
  return (
    <View style={[styles.pill, tone]}>
      <Text style={styles.pillText}>{callStatusLabel(status)}</Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- *
 * Numbers — owned numbers, release, search + buy
 * -------------------------------------------------------------------------- */

function NumbersPanel() {
  const queryClient = useQueryClient();
  const { guard, pending, confirm, cancel } = useStepUp();
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
  });

  const [isoCountry, setIsoCountry] = useState('US');
  const [areaCode, setAreaCode] = useState('');
  const [results, setResults] = useState<readonly AvailableNumber[] | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: PHONE_NUMBERS_QUERY_KEY });

  const search = useMutation({
    mutationFn: () =>
      apiClient.telephony.numbers.search.query({
        isoCountry,
        ...(areaCode.trim() === '' ? {} : { areaCode: areaCode.trim() }),
        limit: 10,
      }),
    onSuccess: setResults,
    onError: (error) => {
      Alert.alert('The search did not complete', apiErrorOf(error)?.error.message);
    },
  });

  const purchase = useMutation({
    mutationFn: (phoneNumber: string) =>
      apiClient.telephony.numbers.purchase.mutate({ phoneNumber }),
    onSuccess: async (_result, phoneNumber) => {
      setResults(
        (current) => current?.filter((n) => String(n.phoneNumber) !== phoneNumber) ?? null,
      );
      await refresh();
    },
    onError: (error, phoneNumber) => {
      if (
        guard(error, () => {
          purchase.mutate(phoneNumber);
        })
      ) {
        return;
      }
      Alert.alert('The number was not purchased', apiErrorOf(error)?.error.message);
    },
  });

  const release = useMutation({
    mutationFn: (phoneNumberId: string) =>
      apiClient.telephony.numbers.release.mutate({ phoneNumberId }),
    onSuccess: refresh,
    onError: (error, phoneNumberId) => {
      if (
        guard(error, () => {
          release.mutate(phoneNumberId);
        })
      ) {
        return;
      }
      Alert.alert('The number was not released', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
      <Section
        label={`This org's numbers${numbers.data !== undefined ? ` · ${String(numbers.data.length)}` : ''}`}
      >
        {numbers.isPending && <ActivityIndicator color={colors.accent.hex} />}
        {numbers.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(numbers.error)?.error.message ?? 'Could not load phone numbers.'}
          </Text>
        )}
        {numbers.data?.length === 0 && (
          <Text style={styles.emptyHint}>No numbers yet — search below to buy the first one.</Text>
        )}
        {numbers.data?.map((number) => (
          <View key={number.phoneNumberId} style={styles.numberRow}>
            <Text style={styles.rowMono}>{String(number.e164)}</Text>
            <Text style={styles.countryTag}>{number.isoCountry}</Text>
            <Text style={styles.rowFaintFlex} numberOfLines={1}>
              bought {format(new Date(number.purchasedAt), 'd MMM yyyy')}
            </Text>
            <Pressable
              disabled={release.isPending}
              onPress={() => {
                Alert.alert('Release this number?', String(number.e164), [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Release',
                    style: 'destructive',
                    onPress: () => {
                      release.mutate(number.phoneNumberId);
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.dangerLinkText}>Release</Text>
            </Pressable>
          </View>
        ))}
      </Section>

      <Section label="Buy a number">
        <View style={styles.buyRow}>
          <View style={styles.buyField}>
            <Text style={styles.fieldLabel}>Country</Text>
            <TextInput
              style={styles.smallInput}
              value={isoCountry}
              maxLength={2}
              autoCapitalize="characters"
              onChangeText={(value) => {
                setIsoCountry(value.toUpperCase());
              }}
            />
          </View>
          <View style={styles.buyField}>
            <Text style={styles.fieldLabel}>Area code (optional)</Text>
            <TextInput
              style={styles.smallInput}
              value={areaCode}
              maxLength={3}
              keyboardType="number-pad"
              placeholder="415"
              placeholderTextColor={colors.inkFaint.hex}
              onChangeText={(value) => {
                setAreaCode(value.replace(/\D/g, ''));
              }}
            />
          </View>
        </View>
        <Pressable
          style={[styles.primaryButton, search.isPending && styles.buttonDisabled]}
          disabled={search.isPending}
          onPress={() => {
            search.mutate();
          }}
        >
          {search.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.primaryButtonText}>Search</Text>
          )}
        </Pressable>
        {search.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(search.error)?.error.message ?? 'The search did not complete.'}
          </Text>
        )}

        {results !== null &&
          (results.length === 0 ? (
            <Text style={styles.emptyHint}>No numbers matched that search.</Text>
          ) : (
            <View style={styles.resultsList}>
              {results.map((available) => (
                <View key={String(available.phoneNumber)} style={styles.resultRow}>
                  <Text style={styles.rowMono}>{String(available.phoneNumber)}</Text>
                  <Text style={styles.rowFaintFlex} numberOfLines={1}>
                    {[available.locality, available.region].filter(Boolean).join(', ') ||
                      available.isoCountry}
                  </Text>
                  <Text style={styles.rowFaint}>
                    ${(available.monthlyCostCents / 100).toFixed(2)}/mo
                  </Text>
                  <Pressable
                    style={[styles.smallPrimaryButton, purchase.isPending && styles.buttonDisabled]}
                    disabled={purchase.isPending}
                    onPress={() => {
                      purchase.mutate(String(available.phoneNumber));
                    }}
                  >
                    <Text style={styles.smallPrimaryButtonText}>Buy</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ))}
        {purchase.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(purchase.error)?.error.message ?? 'The number was not purchased.'}
          </Text>
        )}
      </Section>

      <StepUpSheet visible={pending} onConfirmed={confirm} onCancel={cancel} />
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------- *
 * Messages — SMS threads
 * -------------------------------------------------------------------------- */

function MessagesPanel() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const threads = useQuery({
    queryKey: MESSAGE_THREADS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.messages.threads.query({ limit: 50 })),
  });

  if (composing) {
    return (
      <ComposeView
        onSent={(newThreadId) => {
          setComposing(false);
          setThreadId(newThreadId);
        }}
        onCancel={() => {
          setComposing(false);
        }}
      />
    );
  }

  if (threadId !== null) {
    return (
      <ThreadView
        threadId={threadId}
        onBack={() => {
          setThreadId(null);
        }}
      />
    );
  }

  return (
    <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
      <Pressable
        style={styles.primaryButton}
        onPress={() => {
          setComposing(true);
        }}
      >
        <Text style={styles.primaryButtonText}>New message</Text>
      </Pressable>

      {threads.isPending && <ActivityIndicator color={colors.accent.hex} />}
      {threads.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(threads.error)?.error.message ?? 'Could not load threads.'}
        </Text>
      )}
      {threads.data?.length === 0 && (
        <Text style={styles.emptyHint}>Inbound texts to your numbers land here.</Text>
      )}
      {threads.data?.map((thread) => (
        <Pressable
          key={thread.threadId}
          style={styles.threadRow}
          onPress={() => {
            setThreadId(thread.threadId);
          }}
        >
          <View style={styles.threadRowText}>
            <Text style={styles.rowMono} numberOfLines={1}>
              {String(thread.counterparty)}
            </Text>
            {thread.lastMessageAt !== null && (
              <Text style={styles.rowFaint}>
                {formatDistanceToNow(new Date(thread.lastMessageAt), { addSuffix: true })}
              </Text>
            )}
          </View>
          {thread.unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{thread.unreadCount}</Text>
            </View>
          )}
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ComposeView({
  onSent,
  onCancel,
}: {
  readonly onSent: (threadId: string) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
  });

  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (numbers.data?.[0]?.phoneNumberId ?? '');

  const send = useMutation({
    mutationFn: () =>
      apiClient.telephony.messages.send.mutate({
        to: to.trim(),
        fromPhoneNumberId: activeNumber,
        body: body.trim(),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MESSAGE_THREADS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: threadMessagesQueryKey(result.threadId) }),
      ]);
      onSent(result.threadId);
    },
    onError: (error) => {
      Alert.alert('The message was not sent', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <KeyboardAvoidingView
      style={styles.panelScroll}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.threadHeader}>
        <Text style={styles.threadHeaderText}>New message</Text>
        <Pressable onPress={onCancel}>
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.panelContent}>
        <Text style={styles.fieldLabel}>To — E.164, e.g. +14155550100</Text>
        <TelephonyContactPicker value={to} onChange={setTo} />

        {(numbers.data?.length ?? 0) > 1 && (
          <>
            <Text style={styles.fieldLabel}>From</Text>
            <ChipScroll>
              {(numbers.data ?? []).map((number) => (
                <Pressable
                  key={number.phoneNumberId}
                  style={[styles.chip, activeNumber === number.phoneNumberId && styles.chipActive]}
                  onPress={() => {
                    setFromPhoneNumberId(number.phoneNumberId);
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      activeNumber === number.phoneNumberId && styles.chipTextActive,
                    ]}
                  >
                    {String(number.e164)}
                  </Text>
                </Pressable>
              ))}
            </ChipScroll>
          </>
        )}

        <Text style={styles.fieldLabel}>Message</Text>
        <TextInput
          style={styles.messageInput}
          value={body}
          onChangeText={setBody}
          multiline
          maxLength={1600}
          placeholder="Type a message…"
          placeholderTextColor={colors.inkFaint.hex}
        />

        {activeNumber === '' && (
          <Text style={styles.warningHint}>Buy a number before sending.</Text>
        )}
        {send.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(send.error)?.error.message ?? 'The message was not sent.'}
          </Text>
        )}
        <Pressable
          style={[
            styles.primaryButton,
            (send.isPending || activeNumber === '' || to.trim() === '' || body.trim() === '') &&
              styles.buttonDisabled,
          ]}
          disabled={send.isPending || activeNumber === '' || to.trim() === '' || body.trim() === ''}
          onPress={() => {
            send.mutate();
          }}
        >
          {send.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.primaryButtonText}>Send</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ThreadView({
  threadId,
  onBack,
}: {
  readonly threadId: string;
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
  });
  const threads = useQuery({
    queryKey: MESSAGE_THREADS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.messages.threads.query({ limit: 50 })),
  });
  const messages = useQuery({
    queryKey: threadMessagesQueryKey(threadId),
    queryFn: async () =>
      wire(await apiClient.telephony.messages.list.query({ threadId, limit: 100 })),
  });

  const thread = threads.data?.find((entry) => entry.threadId === threadId);
  const counterparty = thread === undefined ? undefined : String(thread.counterparty);

  const [body, setBody] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (numbers.data?.[0]?.phoneNumberId ?? '');

  const send = useMutation({
    mutationFn: () =>
      apiClient.telephony.messages.send.mutate({
        to: counterparty ?? '',
        fromPhoneNumberId: activeNumber,
        body: body.trim(),
      }),
    onSuccess: async () => {
      setBody('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MESSAGE_THREADS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: threadMessagesQueryKey(threadId) }),
      ]);
    },
    onError: (error) => {
      Alert.alert('The message was not sent', apiErrorOf(error)?.error.message);
    },
  });

  return (
    <KeyboardAvoidingView
      style={styles.panelScroll}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.threadHeader}>
        <Pressable onPress={onBack}>
          <Text style={styles.linkText}>‹ Threads</Text>
        </Pressable>
        <Text style={styles.threadHeaderText} numberOfLines={1}>
          {counterparty ?? '…'}
        </Text>
        <TelephonyCallButton to={counterparty ?? ''} />
      </View>

      <ScrollView contentContainerStyle={styles.messageList}>
        {messages.isPending && <ActivityIndicator color={colors.accent.hex} />}
        {messages.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(messages.error)?.error.message ?? 'Could not load messages.'}
          </Text>
        )}
        {messages.data?.length === 0 && (
          <Text style={styles.emptyHint}>No messages yet — send the first one below.</Text>
        )}
        {[...(messages.data ?? [])].reverse().map((message) => (
          <View
            key={message.messageId}
            style={[
              styles.bubbleRow,
              message.direction === 'outbound' ? styles.bubbleRowOut : styles.bubbleRowIn,
            ]}
          >
            <View
              style={[
                styles.bubble,
                message.direction === 'outbound' ? styles.bubbleOut : styles.bubbleIn,
              ]}
            >
              <Text
                style={
                  message.direction === 'outbound' ? styles.bubbleTextOut : styles.bubbleTextIn
                }
              >
                {message.body}
              </Text>
              <Text
                style={
                  message.direction === 'outbound' ? styles.bubbleTimeOut : styles.bubbleTimeIn
                }
              >
                {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {(numbers.data?.length ?? 0) > 1 && (
        <ChipScroll style={styles.threadFromChips}>
          {(numbers.data ?? []).map((number) => (
            <Pressable
              key={number.phoneNumberId}
              style={[styles.chip, activeNumber === number.phoneNumberId && styles.chipActive]}
              onPress={() => {
                setFromPhoneNumberId(number.phoneNumberId);
              }}
            >
              <Text
                style={[
                  styles.chipText,
                  activeNumber === number.phoneNumberId && styles.chipTextActive,
                ]}
              >
                From {String(number.e164)}
              </Text>
            </Pressable>
          ))}
        </ChipScroll>
      )}
      <View style={styles.composerRow}>
        <TextInput
          style={styles.composerInput}
          value={body}
          onChangeText={setBody}
          placeholder={
            (numbers.data?.length ?? 0) === 0 ? 'Buy a number first…' : 'Type a message…'
          }
          placeholderTextColor={colors.inkFaint.hex}
          editable={(numbers.data?.length ?? 0) > 0}
        />
        <Pressable
          style={[
            styles.sendButton,
            (send.isPending || body.trim() === '' || (numbers.data?.length ?? 0) === 0) &&
              styles.buttonDisabled,
          ]}
          disabled={send.isPending || body.trim() === '' || (numbers.data?.length ?? 0) === 0}
          onPress={() => {
            send.mutate();
          }}
        >
          {send.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </Pressable>
      </View>
      {send.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(send.error)?.error.message ?? 'The message was not sent.'}
        </Text>
      )}
    </KeyboardAvoidingView>
  );
}

/* -------------------------------------------------------------------------- *
 * Spend — current spend and the itemized report
 * -------------------------------------------------------------------------- */

const SINCE_DAYS = 30;

function SpendPanel() {
  const current = useQuery({
    queryKey: SPEND_CURRENT_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.spend.current.query({})),
  });
  const report = useQuery({
    queryKey: spendReportQueryKey(SINCE_DAYS),
    queryFn: async () =>
      wire(await apiClient.telephony.spend.report.query({ sinceDays: SINCE_DAYS })),
  });

  const spentCents = current.data?.spentCents ?? 0;
  const capCents = current.data?.capCents ?? 0;
  const ratio = capCents === 0 ? 0 : spentCents / capCents;
  const over = ratio > 1;

  const automationCapCents = current.data?.automationCapCents ?? null;
  const automationSpentCents = current.data?.automationSpentCents ?? 0;
  const automationRatio =
    automationCapCents === null || automationCapCents === 0
      ? 0
      : automationSpentCents / automationCapCents;
  const automationOver = automationRatio > 1;

  return (
    <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
      <Section label="This organization's spend">
        {current.isPending && <ActivityIndicator color={colors.accent.hex} />}
        {current.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(current.error)?.error.message ?? 'Could not load spend.'}
          </Text>
        )}
        {current.isSuccess && (
          <View style={styles.spendCard}>
            <View style={styles.spendHeaderRow}>
              <Text style={styles.spendAmount}>{formatCents(spentCents)}</Text>
              <Text style={styles.spendCaption}>
                of {formatCents(capCents)} cap · rolling {SINCE_DAYS} days
              </Text>
            </View>
            <View
              style={[
                styles.spendPill,
                over ? styles.pillDanger : ratio > 0.8 ? styles.pillWarning : styles.pillSuccess,
              ]}
            >
              <Text style={styles.pillText}>
                {over ? 'Cap reached' : `${String(Math.round(ratio * 100))}% used`}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: percentWidth(ratio) },
                  over
                    ? styles.progressDanger
                    : ratio > 0.8
                      ? styles.progressWarning
                      : styles.progressAccent,
                ]}
              />
            </View>

            {automationCapCents !== null && (
              <View style={styles.automationBlock}>
                <Text style={styles.automationCaption}>
                  Automation allowance: {formatCents(automationSpentCents)} of{' '}
                  {formatCents(automationCapCents)} · rules only, in addition to the org cap
                </Text>
                <View style={styles.progressTrackSmall}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: percentWidth(automationRatio) },
                      automationOver
                        ? styles.progressDanger
                        : automationRatio > 0.8
                          ? styles.progressWarning
                          : styles.progressAccent,
                    ]}
                  />
                </View>
              </View>
            )}
          </View>
        )}
      </Section>

      <Section label={`Cost attribution — last ${String(SINCE_DAYS)} days`}>
        {report.isPending && <ActivityIndicator color={colors.accent.hex} />}
        {report.isError && (
          <Text style={styles.errorText}>
            {apiErrorOf(report.error)?.error.message ?? 'Could not load the itemized report.'}
          </Text>
        )}
        {report.data?.length === 0 && (
          <Text style={styles.emptyHint}>
            No spend recorded in this window — place a call or send an SMS to see it itemized here.
          </Text>
        )}
        {report.data !== undefined && report.data.length > 0 && (
          <View style={styles.spendTable}>
            <View style={styles.spendTableHeaderRow}>
              <Text style={[styles.spendTableHeader, styles.spendTableKindCol]}>Kind</Text>
              <Text style={[styles.spendTableHeader, styles.spendTableNumCol]}>Count</Text>
              <Text style={[styles.spendTableHeader, styles.spendTableNumCol]}>Est.</Text>
              <Text style={[styles.spendTableHeader, styles.spendTableNumCol]}>Billed</Text>
            </View>
            {report.data.map((row) => (
              <View key={row.kind} style={styles.spendTableRow}>
                <Text style={[styles.spendTableCell, styles.spendTableKindCol]} numberOfLines={1}>
                  {SPEND_KIND_LABEL[row.kind] ?? row.kind}
                </Text>
                <Text style={[styles.spendTableCell, styles.spendTableNumCol]}>{row.count}</Text>
                <Text style={[styles.spendTableCell, styles.spendTableNumCol]}>
                  {formatCents(row.estimatedCents)}
                </Text>
                <Text style={[styles.spendTableCell, styles.spendTableNumCol]}>
                  {formatCents(row.billedCents)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------- *
 * Shared bits
 * -------------------------------------------------------------------------- */

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function ChipScroll({
  children,
  style,
}: {
  readonly children: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.chipScroll, style]}
    >
      {children}
    </ScrollView>
  );
}

/** Cents to a display string — reused directly rather than duplicated; telephony spend is always USD. */
function formatCents(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
}

/** Clamped 0-100 width, as the `${number}%` string RN's width style wants —
 *  same `restrict-template-expressions` workaround `billing.tsx`'s own
 *  `usagePercentWidth` already established. */
function percentWidth(ratio: number): `${number}%` {
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  return (String(percent) + '%') as `${number}%`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  titleRow: {
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  subtitle: {
    paddingHorizontal: 24,
    marginTop: 2,
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  tabStripFrame: {
    flexGrow: 0,
    flexShrink: 0,
    marginTop: 10,
  },
  tabStrip: {
    paddingHorizontal: 24,
    paddingBottom: 10,
    alignItems: 'flex-start',
    gap: 8,
  },
  tab: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: colors.surfaceRaised.hex,
  },
  tabActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  tabTextActive: {
    color: colors.accentInk.hex,
  },
  panelScroll: {
    flex: 1,
  },
  panelContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 20,
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    marginTop: 6,
  },
  smallInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  messageInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  chipScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  threadFromChips: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginRight: 8,
    backgroundColor: colors.surfaceRaised.hex,
  },
  chipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  chipText: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  chipTextActive: {
    color: colors.accentInk.hex,
    fontWeight: '600',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  recordLabel: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  warningHint: {
    fontSize: 12,
    color: colors.warning.hex,
    marginTop: 4,
  },
  errorText: {
    fontSize: 12,
    color: colors.danger.hex,
    marginTop: 4,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
  },
  primaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  smallPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  smallPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 12,
    fontWeight: '600',
  },
  rowCard: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    overflow: 'hidden',
    marginTop: 6,
  },
  rowCardActive: {
    borderColor: colors.accent.hex + '80',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowTrailing: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  directionOut: {
    color: colors.accent.hex,
  },
  directionIn: {
    color: colors.inkFaint.hex,
  },
  rowMono: {
    fontSize: 13,
    color: colors.ink.hex,
    fontVariant: ['tabular-nums'],
  },
  rowFaint: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  rowFaintFlex: {
    flex: 1,
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  recordedTag: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  rowBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  rowBodyMeta: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  rowBodyDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 8,
    marginTop: 2,
    alignItems: 'flex-start',
  },
  recordingsList: {
    gap: 6,
  },
  recordingRow: {
    gap: 4,
  },
  linkText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  dangerLinkText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  transcriptBox: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceSunken.hex,
    padding: 8,
    gap: 4,
  },
  transcriptText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '600',
  },
  pillAccent: {
    backgroundColor: colors.accent.hex + '26',
  },
  pillSuccess: {
    backgroundColor: colors.success.hex + '26',
  },
  pillDanger: {
    backgroundColor: colors.danger.hex + '26',
  },
  pillWarning: {
    backgroundColor: colors.warning.hex + '26',
  },
  pillNeutral: {
    backgroundColor: colors.surfaceSunken.hex,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  countryTag: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  buyRow: {
    flexDirection: 'row',
    gap: 10,
  },
  buyField: {
    gap: 4,
  },
  resultsList: {
    marginTop: 10,
    gap: 6,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
  },
  threadRowText: {
    flex: 1,
    gap: 2,
  },
  unreadBadge: {
    backgroundColor: colors.accent.hex,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  unreadBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.accentInk.hex,
  },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 24,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  threadHeaderText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  messageList: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    gap: 8,
  },
  bubbleRow: {
    flexDirection: 'row',
  },
  bubbleRowOut: {
    justifyContent: 'flex-end',
  },
  bubbleRowIn: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  bubbleOut: {
    backgroundColor: colors.accent.hex,
    borderBottomRightRadius: 4,
  },
  bubbleIn: {
    backgroundColor: colors.surfaceSunken.hex,
    borderBottomLeftRadius: 4,
  },
  bubbleTextOut: {
    fontSize: 13,
    color: colors.accentInk.hex,
  },
  bubbleTextIn: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  bubbleTimeOut: {
    fontSize: 10,
    marginTop: 2,
    color: colors.accentInk.hex + 'b3',
  },
  bubbleTimeIn: {
    fontSize: 10,
    marginTop: 2,
    color: colors.inkFaint.hex,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  sendButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  sendButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  spendCard: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    gap: 8,
  },
  spendHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  spendAmount: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  spendCaption: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    flexShrink: 1,
  },
  spendPill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSunken.hex,
    overflow: 'hidden',
  },
  progressTrackSmall: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceSunken.hex,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressAccent: {
    backgroundColor: colors.accent.hex,
  },
  progressWarning: {
    backgroundColor: colors.warning.hex,
  },
  progressDanger: {
    backgroundColor: colors.danger.hex,
  },
  automationBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 10,
    marginTop: 4,
  },
  automationCaption: {
    fontSize: 11,
    color: colors.inkMuted.hex,
  },
  spendTable: {
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    overflow: 'hidden',
  },
  spendTableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised.hex,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  spendTableHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.inkFaint.hex,
  },
  spendTableRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  spendTableCell: {
    fontSize: 12,
    color: colors.ink.hex,
  },
  spendTableKindCol: {
    flex: 1,
  },
  spendTableNumCol: {
    width: 56,
    textAlign: 'right',
  },
});
