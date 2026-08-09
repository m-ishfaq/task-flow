import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';

/**
 * Every telephony read, in one place (Phase 7 Wave 5 — the UI wave; the API
 * itself shipped Waves 1-4, `apps/api/src/telephony`).
 *
 * `queryOptions` rather than hooks, and `wire()` on every result, for the
 * identical reasons `work/api.ts` and `chat/api.ts` give: shared between a
 * component and a prefetch, and the server's `Date` fields arrive as strings
 * with no transformer configured (`lib/wire.ts`).
 */

interface Outputs {
  numbers: Awaited<ReturnType<typeof api.telephony.numbers.list.query>>;
  availableNumbers: Awaited<ReturnType<typeof api.telephony.numbers.search.query>>;
  calls: Awaited<ReturnType<typeof api.telephony.calls.list.query>>;
  callRecordings: Awaited<ReturnType<typeof api.telephony.recordings.list.query>>;
  cardRecordings: Awaited<ReturnType<typeof api.telephony.cards.recordings.query>>;
  threads: Awaited<ReturnType<typeof api.telephony.messages.threads.query>>;
  messages: Awaited<ReturnType<typeof api.telephony.messages.list.query>>;
  spendCurrent: Awaited<ReturnType<typeof api.telephony.spend.current.query>>;
  spendReport: Awaited<ReturnType<typeof api.telephony.spend.report.query>>;
}

export type PhoneNumberRecord = Wire<Outputs['numbers']>[number];
export type AvailableNumber = Wire<Outputs['availableNumbers']>[number];
export type CallRecord = Wire<Outputs['calls']>[number];
export type CallRecording = Wire<Outputs['callRecordings']>[number];
export type CardRecording = Wire<Outputs['cardRecordings']>[number];
export type MessageThread = Wire<Outputs['threads']>[number];
export type ThreadMessage = Wire<Outputs['messages']>[number];
export type SpendCurrent = Wire<Outputs['spendCurrent']>;
export type SpendReportRow = Wire<Outputs['spendReport']>[number];

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

export function phoneNumbersQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.phoneNumbers(orgId),
    queryFn: async () => wire(await api.telephony.numbers.list.query({})),
  });
}

export function callsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.calls(orgId),
    queryFn: async () => wire(await api.telephony.calls.list.query({ limit: 50 })),
  });
}

export function callRecordingsQuery(orgId: string, callId: string) {
  return queryOptions({
    queryKey: keys.callRecordings(orgId, callId),
    queryFn: async () => wire(await api.telephony.recordings.list.query({ callId })),
  });
}

export function cardRecordingsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.cardRecordings(orgId, cardId),
    queryFn: async () => wire(await api.telephony.cards.recordings.query({ cardId })),
  });
}

export function messageThreadsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.messageThreads(orgId),
    queryFn: async () => wire(await api.telephony.messages.threads.query({ limit: 50 })),
  });
}

export function threadMessagesQuery(orgId: string, threadId: string) {
  return queryOptions({
    queryKey: keys.threadMessages(orgId, threadId),
    queryFn: async () => wire(await api.telephony.messages.list.query({ threadId, limit: 100 })),
  });
}

export function spendCurrentQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.spendCurrent(orgId),
    queryFn: async () => wire(await api.telephony.spend.current.query({})),
  });
}

export function spendReportQuery(orgId: string, sinceDays: number) {
  return queryOptions({
    queryKey: keys.spendReport(orgId, sinceDays),
    queryFn: async () => wire(await api.telephony.spend.report.query({ sinceDays })),
  });
}

/* -------------------------------------------------------------------------- *
 * Invalidation
 *
 * Centralized per `work/api.ts`'s own convention — a caller expresses "a call
 * was placed" and this decides what else that touches (the call log AND the
 * spend figure both move), rather than every mutation site re-deriving it.
 * -------------------------------------------------------------------------- */

export function invalidatePhoneNumbers(client: QueryClient, orgId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: keys.phoneNumbers(orgId) });
}

export async function invalidateAfterSpend(client: QueryClient, orgId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.calls(orgId) }),
    client.invalidateQueries({ queryKey: keys.spendCurrent(orgId) }),
  ]);
}

export function invalidateCallRecordings(
  client: QueryClient,
  orgId: string,
  callId: string,
): Promise<void> {
  return client.invalidateQueries({ queryKey: keys.callRecordings(orgId, callId) });
}

export function invalidateCardRecordings(
  client: QueryClient,
  orgId: string,
  cardId: string,
): Promise<void> {
  return client.invalidateQueries({ queryKey: keys.cardRecordings(orgId, cardId) });
}

export async function invalidateAfterMessage(
  client: QueryClient,
  orgId: string,
  threadId: string | undefined,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.messageThreads(orgId) }),
    ...(threadId === undefined
      ? []
      : [client.invalidateQueries({ queryKey: keys.threadMessages(orgId, threadId) })]),
  ]);
}
