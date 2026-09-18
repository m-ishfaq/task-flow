import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { colors } from '@taskflow/tokens';
import { wire } from '@taskflow/client';
import { apiClient } from '../lib/app-session.js';
import type { CallRecord, CallRecording } from '../lib/telephony.js';
import {
  cardRecordingsQueryKey,
  CALLS_QUERY_KEY,
  callRecordingsQueryKey,
} from '../lib/telephony.js';
import { Section } from './card-detail-shared.js';
import { EmptyHint } from './primitives.js';
import { styles as s } from './card-detail-styles.js';

/**
 * Recordings attached to this card — the mobile counterpart of
 * `apps/web/src/features/work/detail/recording-section.tsx`.
 *
 * Mounted only when `capabilities.readRecordings` is true (Admin/Owner only).
 * Picker is two-step: pick a recorded call, then pick its recording.
 */

export function RecordingSection({
  cardId,
}: {
  readonly cardId: string;
}) {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);

  const attached = useQuery({
    queryKey: cardRecordingsQueryKey(cardId),
    queryFn: async () => wire(await apiClient.telephony.cards.recordings.query({ cardId })),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: cardRecordingsQueryKey(cardId) });

  const detach = useMutation({
    mutationFn: async (recordingId: string) => {
      await apiClient.telephony.cards.detach.mutate({
        recordingId,
        cardId,
      });
    },
    onSuccess: refresh,
  });

  const attach = useMutation({
    mutationFn: async (recordingId: string) => {
      await apiClient.telephony.cards.attach.mutate({
        recordingId,
        cardId,
      });
    },
    onSuccess: () => {
      setPicking(false);
      void refresh();
    },
  });

  const data = attached.data ?? [];

  return (
    <Section label="Recordings">
      {attached.isPending ? (
        <ActivityIndicator color={colors.accent.hex} style={{ height: 40 }} />
      ) : attached.isError ? (
        <EmptyHint>Could not load recordings.</EmptyHint>
      ) : data.length === 0 ? (
        <EmptyHint>No recordings attached.</EmptyHint>
      ) : (
        <View style={{ gap: 4 }}>
          {data.map((recording) => (
            <View key={recording.recordingId} style={s.devRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.label}>
                  {recording.status}
                  {recording.durationSeconds != null ? ` \u00B7 ${String(recording.durationSeconds)}s` : ''}
                </Text>
              </View>
              <Pressable
                onPress={() => { detach.mutate(recording.recordingId); }}
                disabled={detach.isPending}
                hitSlop={8}
              >
                <Text style={s.devUnlink}>Detach</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {picking ? (
        <RecordingPicker
          onAttach={(recordingId) => { attach.mutate(recordingId); }}
          onCancel={() => { setPicking(false); }}
          pending={attach.isPending}
        />
      ) : (
        <Pressable onPress={() => { setPicking(true); }} hitSlop={8} style={{ marginTop: 8 }}>
          <Text style={[s.label, { color: colors.accent.hex }]}>Attach a recording</Text>
        </Pressable>
      )}
    </Section>
  );
}

function RecordingPicker({
  onAttach,
  onCancel,
  pending,
}: {
  readonly onAttach: (recordingId: string) => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}) {
  const calls = useQuery({
    queryKey: CALLS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.calls.list.query({})),
  });
  const [callId, setCallId] = useState<string | null>(null);

  const recorded = (calls.data ?? []).filter((c: CallRecord) => c.recorded);

  return (
    <View style={[s.devForm, { marginTop: 8 }]}>
      {calls.isPending ? (
        <ActivityIndicator color={colors.accent.hex} style={{ height: 40 }} />
      ) : recorded.length === 0 ? (
        <EmptyHint>No recorded calls.</EmptyHint>
      ) : callId === null ? (
        <View style={{ gap: 4 }}>
          {recorded.map((call: CallRecord) => (
            <Pressable key={call.callId} onPress={() => { setCallId(call.callId); }} style={s.devRow}>
              <Text style={s.devRowLabel} numberOfLines={1}>
                {String(call.counterparty)}
                {' \u00B7 '}
                {call.direction}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <RecordingsOfCall
          callId={callId}
          onAttach={onAttach}
          onBack={() => { setCallId(null); }}
          pending={pending}
        />
      )}
      <Pressable onPress={onCancel} hitSlop={8} style={{ marginTop: 4 }}>
        <Text style={s.label}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function RecordingsOfCall({
  callId,
  onAttach,
  onBack,
  pending,
}: {
  readonly callId: string;
  readonly onAttach: (recordingId: string) => void;
  readonly onBack: () => void;
  readonly pending: boolean;
}) {
  const recordings = useQuery({
    queryKey: callRecordingsQueryKey(callId),
    queryFn: async () => wire(await apiClient.telephony.recordings.list.query({ callId })),
  });

  if (recordings.isPending) {
    return <ActivityIndicator color={colors.accent.hex} style={{ height: 40 }} />;
  }
  if (recordings.isError) {
    return <EmptyHint>Could not load recordings.</EmptyHint>;
  }

  const stored = recordings.data.filter((r: CallRecording) => r.status === 'stored');

  return (
    <View style={{ gap: 4 }}>
      {stored.length === 0 ? (
        <EmptyHint>Not stored yet.</EmptyHint>
      ) : (
        stored.map((recording: CallRecording) => (
          <View key={recording.recordingId} style={s.devRow}>
            <Text style={[s.label, { flex: 1 }]}>
              {recording.durationSeconds != null ? `${String(recording.durationSeconds)}s` : '\u2014'}
            </Text>
            <Pressable
              onPress={() => { onAttach(recording.recordingId); }}
              disabled={pending}
              hitSlop={8}
            >
              <Text style={[s.label, { color: colors.accent.hex }]}>Attach</Text>
            </Pressable>
          </View>
        ))
      )}
      <Pressable onPress={onBack} hitSlop={8} style={{ marginTop: 4 }}>
        <Text style={s.label}>Back</Text>
      </Pressable>
    </View>
  );
}
