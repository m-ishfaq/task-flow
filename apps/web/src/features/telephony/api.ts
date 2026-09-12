import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '@taskflow/client';

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
  orgRecordings: Awaited<ReturnType<typeof api.telephony.recordings.browse.query>>;
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
export type OrgRecording = Wire<Outputs['orgRecordings']>[number];
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

/** `listCalls` (`apps/api/src/telephony/call.service.ts`) takes a hard
 *  limit, never a cursor — `calls-panel.tsx`'s own disclosure note, shown
 *  when a page comes back exactly this size, reads this same constant. */
export const CALL_LOG_LIMIT = 50;

export function callsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.calls(orgId),
    queryFn: async () => wire(await api.telephony.calls.list.query({ limit: CALL_LOG_LIMIT })),
  });
}

export function callRecordingsQuery(orgId: string, callId: string) {
  return queryOptions({
    queryKey: keys.callRecordings(orgId, callId),
    queryFn: async () => wire(await api.telephony.recordings.list.query({ callId })),
  });
}

/**
 * Every stored recording, org-wide — the recordings browser
 * (`recordings.browse`, `recording:read`). Fetched as a plain function
 * rather than `queryOptions`, matching `people-page.tsx`'s own precedent
 * for a cursor-paginated list: `useInfiniteQuery` is built inline in the
 * one component that renders it, with `before` (this page's oldest
 * `createdAt`) as the next page's cursor.
 */
export async function orgRecordingsPage(
  before: string | null,
): Promise<{ readonly recordings: readonly OrgRecording[]; readonly nextBefore: string | null }> {
  const page = wire(await api.telephony.recordings.browse.query({ limit: 50, before }));
  const last = page[page.length - 1];
  return {
    recordings: page,
    /* Fewer rows than the page size means there is nothing older left. */
    nextBefore: last === undefined || page.length < 50 ? null : last.createdAt,
  };
}

/**
 * One recording's transcript (`recording:read` — Admin-and-Owner).
 *
 * `retry: false` because the expected answer for most recordings is NOT_FOUND:
 * transcription is a carrier callback that may never arrive, and retrying a
 * definitive "there is no transcript" three times just delays the empty state.
 * A caller without `recording:read` also lands here, and the panel renders the
 * same quiet absence — the server's decision, never re-derived client-side.
 */
export function callTranscriptQuery(orgId: string, recordingId: string) {
  return queryOptions({
    queryKey: keys.callTranscript(orgId, recordingId),
    queryFn: async () => wire(await api.telephony.recordings.transcript.query({ recordingId })),
    retry: false,
  });
}

export function cardRecordingsQuery(orgId: string, cardId: CardId) {
  return queryOptions({
    queryKey: keys.cardRecordings(orgId, cardId),
    queryFn: async () => wire(await api.telephony.cards.recordings.query({ cardId })),
  });
}

/**
 * One dialable person: a member of this org who has a work phone on their
 * membership profile (`people.membership_profiles.work_phone`, migration 0039).
 */
export interface PhoneContact {
  readonly userId: string;
  /** Display name when there is one, the address otherwise — `use-members.ts`'s rule. */
  readonly label: string;
  readonly email: string;
  /** E.164, non-null by construction: members without one are not contacts. */
  readonly phone: string;
}

/* The directory pages at 100 rows a request and the picker wants the whole org,
   so this walks the cursor. Capped: a picker that fires forty requests to fill a
   dropdown is worse than one that shows the first thousand people and says so.
   The cap is on PAGES rather than on matches because the filter is client-side —
   a member with no work phone still costs a row. */
const CONTACT_PAGE_LIMIT = 100;
const CONTACT_PAGE_CAP = 10;

export function phoneContactsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.phoneContacts(orgId),
    queryFn: async (): Promise<readonly PhoneContact[]> => {
      const contacts: PhoneContact[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < CONTACT_PAGE_CAP; page += 1) {
        const result = wire(
          await api.people.directory.list.query({
            ...(cursor === undefined ? {} : { cursor }),
            limit: CONTACT_PAGE_LIMIT,
          }),
        );

        for (const member of result.members) {
          /* `?? ''` would put an empty string in the To field for a member whose
             number was cleared — an enabled Call button that dials nothing. */
          if (member.workPhone === null || member.workPhone === '') continue;
          contacts.push({
            userId: member.userId,
            label: member.displayName ?? member.email,
            email: member.email,
            phone: member.workPhone,
          });
        }

        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      return contacts;
    },
    /* Work phones change about as often as membership does, and this list is
       read every time the composer opens — the same minute `use-members.ts`
       accepts for the member list, for the same reason. */
    staleTime: 60_000,
    /* A member without `member:read` gets FORBIDDEN here, which is not an error
       the caller needs to see: the picker hides and the field still takes a
       typed number. `query.ts` already classifies FORBIDDEN as terminal, so this
       costs one refused request per stale window, not a retry storm. */
    retry: false,
  });
}

/** `listThreads` (the route behind `messages.threads`) takes a hard limit
 *  too — `messages-panel.tsx`'s own disclosure note reads this constant,
 *  the identical shape `CALL_LOG_LIMIT` gives its sibling above. */
export const MESSAGE_THREADS_LIMIT = 50;

export function messageThreadsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.messageThreads(orgId),
    queryFn: async () =>
      wire(await api.telephony.messages.threads.query({ limit: MESSAGE_THREADS_LIMIT })),
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
