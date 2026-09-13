import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import {
  Check,
  ChevronLeft,
  Copy,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Plus,
  User,
} from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import {
  Avatar,
  Button,
  Empty,
  Field,
  SearchInput,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { formatCallClock, formatCallDuration, formatRelative } from '../../lib/format.js';
import {
  CALL_LOG_LIMIT,
  callRecordingsQuery,
  callTranscriptQuery,
  callsQuery,
  invalidateAfterSpend,
  phoneContactsQuery,
  phoneNumbersQuery,
  type CallRecord,
  type PhoneContact,
} from './api.js';
import { CallButton } from './call-button.js';
import { ContactPicker } from './contact-picker.js';

/**
 * Click-to-call and the call log (ai/phase-7-voice.md §3.5, §3.10, Wave 2) —
 * redesigned to the Design Bible's own §09 shape: a list on the left, one
 * call's detail on the right, and a single "+ New call" entry point rather
 * than an always-open dial form competing with the log for space.
 *
 * ## What "Connected · 4:12" can honestly mean here
 *
 * The Design Bible's in-call widget (also used by `features/rtc/call-
 * surface.tsx`) shows live mic-mute and hang-up controls. A telephony call
 * placed from here is bridged entirely by the carrier between two real phone
 * lines — there is no browser audio path and no API in `apps/api/src/
 * telephony` to mute or end a call already in progress (unlike an in-app RTC
 * call, which this browser tab is actually a participant in). So the detail
 * panel below borrows the widget's VISUAL language — a live, ticking clock
 * next to a pulsing dot once the carrier reports `in_progress` — without the
 * mic/hang-up controls, since offering a button with no real action behind
 * it is worse than one fewer button (the same rule `card_create`'s own
 * comment states for a tool with nothing to call).
 *
 * ## The selected call lives in the URL, not local state
 *
 * `call` (`routerRoute`'s own search schema) is what a transcript search hit
 * already links to — reusing it as "which call is open" rather than adding a
 * second piece of state is what makes a selected call a shareable,
 * back-button-correct link, the same reasoning `chatRoute`'s `channel` and
 * `docsRoute`'s `page` already establish. It also removes the previous
 * version's "derived during render" dance that kept a separate `expanded`
 * boolean in sync with this param — reading the param directly is simpler
 * and cannot drift.
 *
 * ## Polling while a call is still moving
 *
 * Nothing pushes a call-status webhook to this tab (`apps/web/src/lib/
 * socket.ts` has no telephony event at all), so a call sitting at `queued`
 * or `ringing` would never visibly become `in_progress` — or `in_progress`
 * become `completed` — without a manual reload. `refetchInterval` below
 * polls only while at least one row in the log is still non-terminal, so a
 * quiet call log stays completely idle.
 */

const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: 'Queued',
  ringing: 'Ringing',
  in_progress: 'In progress',
  completed: 'Completed',
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Failed',
  canceled: 'Canceled',
};

const TERMINAL_STATUSES = new Set(['completed', 'busy', 'no_answer', 'failed', 'canceled']);
const MISSED_STATUSES = new Set(['busy', 'no_answer', 'failed', 'canceled']);

/** Digits only, so `+1 415 555 0100` and `+14155550100` are one number —
 * the identical normalization `contact-picker.tsx` already uses, duplicated
 * rather than shared: a one-line pure function, not worth a cross-file
 * export for. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * A raw E.164 string, punctuated the way a real phone's call log shows it —
 * "(415) 555-0142" rather than "+14155550142" — for the two shapes this
 * app's own seed numbers (and the overwhelming majority of real ones) take:
 * NANP (`+1` — US/Canada) and the UK. Anything else is returned unchanged
 * rather than guessed at with a wrong grouping; there is no phone-number
 * library in this project, and adding one for cosmetic grouping alone is a
 * bigger dependency than this polish is worth.
 */
function formatPhoneDisplay(e164: string): string {
  const digits = digitsOf(e164);
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
  }
  if (digits.length === 12 && digits.startsWith('44')) {
    return `+44 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
  }
  return e164;
}

/**
 * A phone number, resolved to a colleague when it matches one.
 *
 * The Design Bible's own §09 call log shows a name and a real avatar disc
 * per row, not the bare E.164 string this panel used to render — matching
 * `contact-picker.tsx`'s own reasoning for why a call's destination is
 * looked up against the org directory rather than shown as a raw number
 * the caller has to recognize by memory. A call to or from a number that
 * matches no colleague (the common case — most calls are to customers, not
 * coworkers) still renders correctly: no resolved name, the raw number as
 * both the avatar's identity and its label.
 */
function contactFor(
  counterparty: string,
  byDigits: ReadonlyMap<string, PhoneContact>,
): PhoneContact | undefined {
  return byDigits.get(digitsOf(counterparty));
}

/** Forces a re-render once a second while `active` — the identical ticker
 * `features/rtc/call-surface.tsx` uses for its own live call clock,
 * duplicated rather than shared since it is three lines with no state of
 * its own to keep in sync across files. */
function useTicker(active: boolean): void {
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => {
      forceRender((value) => value + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [active]);
}

function elapsedSeconds(sinceMs: number): number {
  return Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
}

export function CallsPanel({ orgId }: { readonly orgId: string }) {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const numbers = useQuery(phoneNumbersQuery(orgId));
  const contacts = useQuery(phoneContactsQuery(orgId));
  const contactsByDigits = new Map(
    (contacts.data ?? []).map((contact) => [digitsOf(contact.phone), contact] as const),
  );

  const calls = useQuery({
    ...callsQuery(orgId),
    refetchInterval: (query) => {
      const rows = query.state.data;
      return rows?.some((call) => !TERMINAL_STATUSES.has(call.status)) === true ? 4000 : false;
    },
  });

  /* `?call=` — see this file's own header on why the selection lives here
     rather than in local state. */
  const selectedCallId = useSearch({ from: '/calls', select: (value) => value.call });
  const selectedCall = calls.data?.find((call) => call.callId === selectedCallId);

  const selectCall = (callId: string | undefined) => {
    void navigate({ to: '/calls', search: { tab: 'calls', thread: undefined, call: callId } });
  };

  const [callSearch, setCallSearch] = useState('');
  const callNeedle = callSearch.trim().toLowerCase();
  const visibleCalls = (calls.data ?? []).filter((call) => {
    if (callNeedle === '') return true;
    const contact = contactFor(String(call.counterparty), contactsByDigits);
    return (
      String(call.counterparty).toLowerCase().includes(callNeedle) ||
      (contact?.label.toLowerCase().includes(callNeedle) ?? false)
    );
  });

  const owned = numbers.data ?? [];

  const goBuyNumber = () => {
    void navigate({ to: '/calls', search: { tab: 'numbers', thread: undefined, call: undefined } });
  };

  /* Below `md`, the list and the detail panel cannot share a phone-width
     screen — the identical split `chat-page.tsx` already uses for channels,
     driven by the same single source of truth (the URL) rather than a
     second "which pane is active" flag. */
  const showList = isDesktop || selectedCallId === undefined;
  const showDetail = isDesktop || selectedCallId !== undefined;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-[85%] flex-col p-4">
      {/* One bordered card holding BOTH panes, the Design Bible's own §09
          shape — not two independently floating columns, one boxed and one
          not, which is what this used to be. `md:divide-x` draws the single
          vertical seam between them; each pane supplies its own scrolling,
          so this outer card never needs to. */}
      <div className="flex min-h-0 flex-1 divide-line overflow-hidden rounded-xl border border-line bg-surface-raised md:divide-x">
        {showList && (
          <div className="flex min-h-0 w-full flex-col md:w-[70%] md:shrink-0">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-3">
              <h2 className="text-[13px] font-semibold text-ink">Calls</h2>
              {calls.data !== undefined && (
                <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                  {calls.data.length}
                </span>
              )}
              <div className="ml-auto">
                <NewCallButton orgId={orgId} onPlaced={selectCall} />
              </div>
            </div>

            {!numbers.isPending && owned.length === 0 && (
              <div className="flex items-center justify-between gap-2 border-b border-line bg-warning/5 px-3.5 py-2">
                <p className="text-xs text-warning">Buy a number before placing calls.</p>
                <button
                  type="button"
                  onClick={goBuyNumber}
                  className="shrink-0 text-xs font-medium text-accent hover:underline"
                >
                  Buy one
                </button>
              </div>
            )}

            {calls.data !== undefined && calls.data.length > 8 && (
              <div className="border-b border-line px-3.5 py-2">
                <SearchInput
                  value={callSearch}
                  onChange={setCallSearch}
                  placeholder="Search by number or contact…"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {calls.isPending ? (
                <SkeletonRows rows={4} />
              ) : calls.isError ? (
                <ErrorView error={calls.error} title="Could not load the call log" />
              ) : calls.data.length === 0 ? (
                <Empty
                  icon={<Phone aria-hidden="true" className="size-5" strokeWidth={2} />}
                  title="No calls yet"
                  description="Calls you place or receive appear here with their status and any recording."
                />
              ) : visibleCalls.length === 0 ? (
                <p className="px-2 py-3 text-xs text-ink-faint">No calls match your search.</p>
              ) : (
                <ul className="space-y-1">
                  {visibleCalls.map((call) => (
                    <CallListRow
                      key={call.callId}
                      call={call}
                      contact={contactFor(String(call.counterparty), contactsByDigits)}
                      selected={call.callId === selectedCallId}
                      onSelect={() => {
                        selectCall(call.callId);
                      }}
                    />
                  ))}
                </ul>
              )}
              {/* `listCalls` takes a hard limit, never a cursor — there is no
                  "load more" to offer, so the honest fix is telling the
                  person their log stops here rather than letting a full page
                  read as "that's everything". */}
              {calls.data?.length === CALL_LOG_LIMIT && (
                <p className="px-2 py-2 text-center text-xs text-ink-faint">
                  Showing your most recent {CALL_LOG_LIMIT} calls.
                </p>
              )}
            </div>
          </div>
        )}

        {showDetail && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedCallId === undefined ? (
              <DetailPlaceholder
                icon={<Phone aria-hidden="true" className="size-5" strokeWidth={2} />}
                title="No call selected"
                description="Pick a call on the left, or place a new one."
              />
            ) : selectedCall === undefined ? (
              calls.isPending ? (
                <div className="p-4">
                  <SkeletonRows rows={4} />
                </div>
              ) : (
                <DetailPlaceholder
                  title="Call not found"
                  description="That call is no longer in the log."
                />
              )
            ) : (
              <CallDetailPanel
                orgId={orgId}
                call={selectedCall}
                contact={contactFor(String(selectedCall.counterparty), contactsByDigits)}
                onBack={() => {
                  selectCall(undefined);
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The detail pane's own "nothing to show" state — plain centered text, not
 * the boxed, dashed-border `Empty` component. `Empty` draws its own visible
 * rectangle, which reads as a box nested inside the box this pane already
 * sits in (the unified card above) — exactly the "two overlapping frames"
 * look the redesign above exists to remove.
 */
function DetailPlaceholder({
  icon,
  title,
  description,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      {icon !== undefined && (
        <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-surface-hover text-ink-faint">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-xs text-xs text-ink-muted">{description}</p>
    </div>
  );
}

/**
 * The small call-direction arrow every real phone's call log shows inline,
 * next to the name — not a second icon competing with the avatar for
 * attention. Red for a missed call is the one color that carries meaning on
 * its own (iOS colors the whole row's name red for exactly this reason);
 * inbound/outbound otherwise read by their arrow direction alone, the same
 * way a phone's own log expects to be scanned.
 */
function DirectionGlyph({
  direction,
  missed,
}: {
  readonly direction: 'inbound' | 'outbound';
  readonly missed: boolean;
}) {
  const Icon = missed ? PhoneMissed : direction === 'outbound' ? PhoneOutgoing : PhoneIncoming;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'size-3 shrink-0',
        missed ? 'text-danger' : direction === 'outbound' ? 'text-accent' : 'text-success',
      )}
      strokeWidth={2.5}
    />
  );
}

/**
 * A colleague gets the app's real hashed-hue avatar disc; a number that
 * matches nobody gets a plain "unsaved contact" silhouette instead — the
 * identical placeholder a real phone shows for a number with no photo, and
 * never `Avatar`'s own initials logic run against raw digits. `initialsOf`
 * reads an email-shaped label ("first.last@…" → "FL"); fed a bare E.164
 * string like `+14155550142` it produced the number's own leading digits
 * ("14"), which is not an identity, just noise. A generic phone glyph here
 * was the first fix and was still wrong: it duplicated the row's own
 * direction arrow right next to it, reading as two unrelated "this is a
 * phone call" icons rather than one avatar and one indicator.
 */
function CallerAvatar({
  contact,
  size = 'sm',
}: {
  readonly contact: PhoneContact | undefined;
  readonly size?: 'sm' | 'lg';
}) {
  if (contact !== undefined) {
    return <Avatar userId={contact.userId} label={contact.label} size={size} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-surface-hover text-ink-faint',
        size === 'lg' ? 'size-[52px]' : 'size-6',
      )}
    >
      <User className={size === 'lg' ? 'size-6' : 'size-3.5'} strokeWidth={2} />
    </span>
  );
}

function CallListRow({
  call,
  contact,
  selected,
  onSelect,
}: {
  readonly call: CallRecord;
  readonly contact: PhoneContact | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const missed = MISSED_STATUSES.has(call.status);
  const live = !TERMINAL_STATUSES.has(call.status);
  const counterparty = String(call.counterparty);
  const label = contact?.label ?? formatPhoneDisplay(counterparty);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-[var(--motion-fast)]',
          selected
            ? 'border-suite-calls/40 bg-suite-calls/10'
            : 'border-transparent hover:bg-surface-hover',
        )}
      >
        <CallerAvatar contact={contact} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <DirectionGlyph direction={call.direction} missed={missed} />
            <span className="sr-only">
              {missed ? 'Missed' : call.direction === 'outbound' ? 'Outbound' : 'Inbound'}{' '}
              call,{' '}
            </span>
            <span
              className={cn('truncate text-xs font-semibold', missed ? 'text-danger' : 'text-ink')}
            >
              {label}
            </span>
          </span>
          {contact !== undefined && (
            <span className="block truncate font-mono text-[10px] text-ink-faint">
              {formatPhoneDisplay(counterparty)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          {missed ? (
            <span className="text-xs font-medium text-danger">
              {STATUS_LABELS[call.status] ?? 'Missed'}
            </span>
          ) : live ? (
            <span className="flex items-center gap-1 text-xs font-medium text-accent">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-accent" />
              {STATUS_LABELS[call.status] ?? 'Live'}
            </span>
          ) : call.durationSeconds !== null ? (
            <span className="text-xs text-ink-muted">
              {formatCallDuration(call.durationSeconds)}
            </span>
          ) : null}
          {call.startedAt !== null && (
            <span className="text-[10px] text-ink-faint">{formatRelative(call.startedAt)}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function CallDetailPanel({
  orgId,
  call,
  contact,
  onBack,
}: {
  readonly orgId: string;
  readonly call: CallRecord;
  readonly contact: PhoneContact | undefined;
  readonly onBack: () => void;
}) {
  const isLive = call.status === 'in_progress';
  useTicker(isLive);
  const liveSeconds =
    isLive && call.startedAt !== null ? elapsedSeconds(new Date(call.startedAt).getTime()) : 0;

  const missed = MISSED_STATUSES.has(call.status);
  const counterparty = String(call.counterparty);
  const label = contact?.label ?? formatPhoneDisplay(counterparty);

  const statusLine =
    call.status === 'queued'
      ? 'Dialling…'
      : call.status === 'ringing'
        ? 'Ringing…'
        : call.status === 'in_progress'
          ? `Connected · ${formatCallClock(liveSeconds)}`
          : call.status === 'completed' && call.durationSeconds !== null
            ? `Completed · ${formatCallDuration(call.durationSeconds)}`
            : (STATUS_LABELS[call.status] ?? call.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to calls"
          className="shrink-0 md:hidden"
        >
          <ChevronLeft aria-hidden="true" className="size-4 text-ink-faint" />
        </button>
        <CallerAvatar contact={contact} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink">{label}</p>
          {contact !== undefined && (
            <p className="truncate font-mono text-xs text-ink-faint">
              {formatPhoneDisplay(counterparty)}
            </p>
          )}
          <p
            className={cn(
              'mt-0.5 flex items-center gap-1.5 text-xs font-medium',
              missed ? 'text-danger' : isLive ? 'text-success' : 'text-ink-muted',
            )}
          >
            {isLive && (
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-success" />
            )}
            {statusLine}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <CallButton orgId={orgId} to={counterparty} label="Call back" variant="primary" />
          <CopyNumberButton number={counterparty} />
        </div>

        {call.startedAt !== null && (
          <p className="text-xs text-ink-faint">
            {call.direction === 'outbound' ? 'Placed' : 'Received'} {formatRelative(call.startedAt)}
          </p>
        )}

        <div className="border-t border-line pt-3">
          {call.recorded ? (
            <CallRecordings orgId={orgId} callId={call.callId} />
          ) : (
            <p className="text-xs text-ink-faint">This call was not recorded.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyNumberButton({ number }: { readonly number: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="gap-1.5"
      onClick={() => {
        void navigator.clipboard.writeText(number).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-success" strokeWidth={2.5} />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" strokeWidth={2} />
      )}
      {copied ? 'Copied' : 'Copy number'}
    </Button>
  );
}

/**
 * "+ New call" — the Design Bible's own single entry point, replacing the
 * dial form that used to sit permanently above the log. Reports the placed
 * call's own id back to the caller so the log can select it immediately
 * rather than leaving the detail panel on whatever was open before.
 */
function NewCallButton({
  orgId,
  onPlaced,
}: {
  readonly orgId: string;
  readonly onPlaced: (callId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="gap-1.5"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Plus aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
        New call
      </Button>
      {open && (
        <NewCallDialogBody
          orgId={orgId}
          onClose={() => {
            setOpen(false);
          }}
          onPlaced={(callId) => {
            setOpen(false);
            onPlaced(callId);
          }}
        />
      )}
    </ModalRoot>
  );
}

/* A separate component, mounted only while `open` — matching
   `pr-diff-dialog.tsx`'s own precedent: the form's queries and mutation have
   no reason to exist before someone actually opens the dialog. */
function NewCallDialogBody({
  orgId,
  onClose,
  onPlaced,
}: {
  readonly orgId: string;
  readonly onClose: () => void;
  readonly onPlaced: (callId: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const numbers = useQuery(phoneNumbersQuery(orgId));

  const [to, setTo] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const [record, setRecord] = useState(false);

  const owned = numbers.data ?? [];
  /* What the select DISPLAYS is what gets submitted — see the original
     dialler's own note on this: a caller who accepts the default must not
     submit an empty id just because the state variable itself never changed. */
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (owned[0]?.phoneNumberId ?? '');

  const place = useMutation({
    mutationFn: () =>
      api.telephony.calls.place.mutate({
        to: to.trim(),
        fromPhoneNumberId: activeNumber,
        record,
      }),
    onSuccess: async (result) => {
      await invalidateAfterSpend(queryClient, orgId);
      if (result.announcementRequired) {
        toast.show('Call placed', {
          description: 'A recording announcement will play before it starts.',
        });
      } else {
        toast.show('Call placed');
      }
      onPlaced(result.callId);
    },
    onError: (error) => {
      toast.failure('The call was not placed', error);
    },
  });

  return (
    <ModalContent size="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          place.mutate();
        }}
      >
        <div className="border-b border-line px-4 py-3">
          <ModalTitle>New call</ModalTitle>
        </div>
        <ModalDescription className="sr-only">
          Place an outbound call from one of this organization&apos;s phone numbers.
        </ModalDescription>

        <div className="space-y-3 px-4 py-4">
          <Field label="To" htmlFor="new-call-to" hint="Pick a person, or type E.164">
            <ContactPicker id="new-call-to" orgId={orgId} value={to} onChange={setTo} />
          </Field>

          <Field label="From" htmlFor="new-call-from">
            <select
              id="new-call-from"
              value={activeNumber}
              disabled={owned.length === 0}
              onChange={(event) => {
                setFromPhoneNumberId(event.target.value);
              }}
              className="h-9 w-full rounded-md border border-line bg-surface-sunken px-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50"
            >
              {owned.length === 0 && <option value="">No numbers yet</option>}
              {owned.map((number) => (
                <option key={number.phoneNumberId} value={number.phoneNumberId}>
                  {String(number.e164)}
                </option>
              ))}
            </select>
          </Field>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted select-none">
            <input
              type="checkbox"
              checked={record}
              onChange={(event) => {
                setRecord(event.target.checked);
              }}
              className="size-3.5 accent-accent"
            />
            Record this call
          </label>

          {!numbers.isPending && owned.length === 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 px-2.5 py-1.5">
              <p className="text-xs text-warning">Buy a number before placing calls.</p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void navigate({
                    to: '/calls',
                    search: { tab: 'numbers', thread: undefined, call: undefined },
                  });
                }}
                className="shrink-0 text-xs font-medium text-accent hover:underline"
              >
                Buy a number
              </button>
            </div>
          )}
          {place.isError && <ErrorText error={place.error} />}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={place.isPending || activeNumber === '' || to.trim() === ''}
          >
            {place.isPending ? 'Calling…' : 'Call'}
          </Button>
        </div>
      </form>
    </ModalContent>
  );
}

function CallRecordings({ orgId, callId }: { readonly orgId: string; readonly callId: string }) {
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const recordings = useQuery(callRecordingsQuery(orgId, callId));

  const download = useMutation({
    mutationFn: (recordingId: string) => api.telephony.recordings.download.mutate({ recordingId }),
    onSuccess: (result) => {
      /* Single-use, short-lived, and never fetched from here — navigating is
         what `attachment-section.tsx` does for the identical reason. */
      window.location.assign(result.url);
    },
    onError: (error, recordingId) => {
      if (
        guard(error, () => {
          download.mutate(recordingId);
        })
      ) {
        return;
      }
      toast.failure('The recording could not be opened', error);
    },
  });

  if (recordings.isPending) return <SkeletonRows rows={1} />;
  if (recordings.isError) return <ErrorText error={recordings.error} />;
  if (recordings.data.length === 0) {
    return <p className="text-xs text-ink-faint">No recording stored yet.</p>;
  }

  return (
    <>
      <ul className="space-y-1">
        {recordings.data.map((recording) => (
          <li key={recording.recordingId} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">
                {recording.status}
                {recording.durationSeconds !== null &&
                  ` · ${formatCallDuration(recording.durationSeconds)}`}
              </span>
              {recording.status === 'stored' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  disabled={download.isPending}
                  onClick={() => {
                    download.mutate(recording.recordingId);
                  }}
                >
                  Download
                </Button>
              )}
            </div>
            <Transcript orgId={orgId} recordingId={recording.recordingId} />
          </li>
        ))}
      </ul>
      {download.isError && <ErrorText error={download.error} />}
      {dialog}
    </>
  );
}

/**
 * A recording's transcript, which Phase 8 Wave 3 made searchable and which
 * until now had no surface at all — `telephony.recordings.transcript` shipped
 * in Phase 7 Wave 2 with no caller, so a transcript search hit would have
 * navigated to a call that showed nothing.
 *
 * Renders NOTHING on error rather than an error box. The overwhelmingly common
 * failure is NOT_FOUND — most calls are never transcribed — and a red panel on
 * every un-transcribed recording would train people to ignore the one that
 * matters. A caller lacking `recording:read` lands in the same branch, which is
 * the honest outcome: the server decided, and the UI does not re-derive it or
 * explain what it is not being shown (§8.7).
 *
 * The text is already redacted at rest (`comms.transcripts` has no unredacted
 * column), so nothing here has to redact anything — the display is plain text
 * for the same reason the search snippet is.
 */
function Transcript({
  orgId,
  recordingId,
}: {
  readonly orgId: string;
  readonly recordingId: string;
}) {
  const transcript = useQuery(callTranscriptQuery(orgId, recordingId));

  if (transcript.isPending || transcript.isError) return null;

  return (
    <details className="rounded-md border border-line bg-surface-sunken px-2 py-1">
      <summary className="cursor-pointer text-xs text-ink-muted">Transcript</summary>
      <p className="mt-1 text-xs whitespace-pre-wrap text-ink-muted">{transcript.data.text}</p>
    </details>
  );
}
