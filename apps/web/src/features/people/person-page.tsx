import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { isPast } from 'date-fns';
import { useState } from 'react';
import { useSession } from '../../lib/session.js';
import { keys } from '../../lib/query.js';
import { displayName, formatDate } from '../../lib/format.js';
import { parseNullableInstant } from '../../lib/wire.js';
import {
  Avatar,
  Badge,
  Button,
  Field,
  Input,
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { CallButton } from '../telephony/call-button.js';
import { useToast } from '../../lib/toast-context.js';
import {
  directoryMemberQuery,
  directoryQuery,
  setReportingLine,
  updateMembershipProfile,
  type DirectoryDetail,
} from './api.js';

/**
 * One person in the org (Phase 11.5 Wave 2, ai/phase-11.5-people.md §3.6).
 *
 * The org chart: who they report to, who reports to them, plus the org-scoped
 * facts (job title, department, out-of-office state as the directory shows
 * it). Edit affordances for ANOTHER member's membership facts are shown and
 * the server answers (§8.2 — the UI never re-derives authorization): a caller
 * without `member:manage` gets an honest FORBIDDEN toast and the row stays as
 * it was. Self-service on one's OWN job title happens on `/account` through
 * `people.profile.update`, which is why this page hides the edit controls for
 * yourself — editing yourself here would be a second, redundant path.
 */
export function PersonPage({ userId }: { readonly userId: string }) {
  const orgId = useSession((state) => state.orgId) ?? '';
  const me = useSession((state) => state.userId);

  const detail = useQuery(directoryMemberQuery(orgId, userId));

  if (detail.isPending) return <SkeletonRows rows={5} className="mx-auto max-w-3xl p-6" />;
  if (detail.isError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ErrorView error={detail.error} title="Could not load this person" />
      </div>
    );
  }

  const member = detail.data;
  const label = displayName({ name: member.displayName, email: member.email });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header className="flex items-center gap-4">
        <Avatar userId={member.userId} label={label} size="sm" className="size-12 text-lg" />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-ink">{label}</h1>
          <p className="truncate text-xs text-ink-muted">
            {member.email}
            {member.userId === me ? <span className="text-ink-faint"> · you</span> : null}
          </p>
        </div>
        <span className="ml-auto">
          <Badge>{member.role}</Badge>
        </span>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <ChartCard
          title="Reports to"
          empty="No one — top of the chart."
          people={member.manager === null ? [] : [member.manager]}
        />
        <ChartCard
          title="Reports to them"
          empty="No direct reports yet."
          people={member.directReports}
        />
      </section>

      <Section title="Job" description="Org-scoped facts about this membership.">
        {member.jobTitle === null && member.department === null && member.workPhone === null ? (
          <p className="text-sm text-ink-faint">Nothing set yet.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {member.jobTitle !== null && <Badge>{member.jobTitle}</Badge>}
            {member.department !== null && <Badge>{member.department}</Badge>}
            {member.workPhone !== null && (
              <>
                <span className="font-mono text-xs text-ink-muted">{member.workPhone}</span>
                {/* Click-to-call from a contact — PLAN.md §3.4's second of the
                    three surfaces it names. The button renders for everyone and
                    the server decides; a member without `call:place` gets a real
                    FORBIDDEN rather than a control that quietly is not there. */}
                <CallButton orgId={orgId} to={member.workPhone} variant="primary" />
              </>
            )}
          </div>
        )}
      </Section>

      <OutOfOfficeSection member={member} />

      {member.userId !== me && <AdminSection member={member} orgId={orgId} />}
    </div>
  );
}

function ChartCard({
  title,
  empty,
  people,
}: {
  readonly title: string;
  readonly empty: string;
  readonly people: readonly { userId: string; displayName: string | null; email: string }[];
}) {
  return (
    <div className="rounded-lg border border-line p-4">
      <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      {people.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {people.map((person) => (
            <li key={person.userId}>
              <Link
                to="/people/$userId"
                params={{ userId: person.userId }}
                className="flex items-center gap-2 text-sm text-ink hover:text-accent"
              >
                <Avatar
                  userId={person.userId}
                  label={displayName({ name: person.displayName, email: person.email })}
                  size="xs"
                />
                {displayName({ name: person.displayName, email: person.email })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Out of office
 * -------------------------------------------------------------------------- */

function OutOfOfficeSection({ member }: { readonly member: DirectoryDetail }) {
  const from = parseNullableInstant(member.oooFrom);
  const until = parseNullableInstant(member.oooUntil);

  if (until === null) {
    return (
      <Section title="Out of office">
        <p className="text-sm text-ink-faint">Not out of office.</p>
      </Section>
    );
  }

  /* "Out now" vs "Scheduled" — the same future-OOO distinction `oooStatus`
     draws for the directory badge, rendered as text here. `isPast` from
     date-fns owns the clock, exactly as `oooStatus` does in format.ts. */
  const started = from === null || isPast(from);

  return (
    <Section title="Out of office">
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-ink">
          {started ? 'Out now' : 'Scheduled'} ·{' '}
          {from === null ? '' : `${formatDate(from.toISOString())} – `}
          {formatDate(until.toISOString())}
        </span>
        {member.oooMessage !== null && (
          <span className="text-xs text-ink-muted">“{member.oooMessage}”</span>
        )}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- *
 * Admin: job facts + reporting line (Wave 2)
 * -------------------------------------------------------------------------- */

function AdminSection({
  member,
  orgId,
}: {
  readonly member: DirectoryDetail;
  readonly orgId: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [managerId, setManagerId] = useState(member.managerUserId ?? '');
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? '');
  const [department, setDepartment] = useState(member.department ?? '');
  const [workPhone, setWorkPhone] = useState(member.workPhone ?? '');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: keys.member(orgId, member.userId) });
    void queryClient.invalidateQueries({ queryKey: keys.directoryAll(orgId) });
    /* The dialable-people list is the directory folded down by work phone
       (`telephony/api.ts`), and it is cached under its OWN key — so setting a
       work phone here would leave the call composer's picker without this
       person for its full stale window unless this says so. */
    void queryClient.invalidateQueries({ queryKey: keys.phoneContacts(orgId) });
  };

  const setManager = useMutation({
    mutationFn: setReportingLine,
    onSuccess: () => {
      invalidate();
      toast.show('Reporting line updated');
    },
    onError: (error) => {
      toast.failure('Could not update the reporting line', error);
    },
  });

  const saveFacts = useMutation({
    mutationFn: updateMembershipProfile,
    onSuccess: () => {
      invalidate();
      toast.show('Profile updated');
    },
    onError: (error) => {
      toast.failure('Could not save those details', error);
    },
  });

  /* The directory is small (orgs are, by this app's own convention) and the
     options are needed the moment the picker is touched, so it loads with the
     page and the mutation decides whether the server allows the change. */
  const directory = useQuery({ ...directoryQuery(orgId, null, 100) });

  return (
    <Section
      title="Manage member"
      description="Job facts and the reporting line. Needs member:manage — the server answers if not."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title" htmlFor="person-job-title">
          <Input
            id="person-job-title"
            value={jobTitle}
            maxLength={120}
            placeholder="e.g. Staff engineer"
            onChange={(event) => {
              setJobTitle(event.target.value);
            }}
          />
        </Field>
        <Field label="Department" htmlFor="person-department">
          <Input
            id="person-department"
            value={department}
            maxLength={120}
            placeholder="e.g. Engineering"
            onChange={(event) => {
              setDepartment(event.target.value);
            }}
          />
        </Field>
        <Field
          label="Work phone"
          htmlFor="person-work-phone"
          hint="E.164, e.g. +14155550100 — enables click-to-call"
        >
          <Input
            id="person-work-phone"
            value={workPhone}
            maxLength={16}
            placeholder="+14155550100"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setWorkPhone(event.target.value);
            }}
          />
        </Field>
      </div>

      <Field label="Manager" htmlFor="person-manager">
        <select
          id="person-manager"
          className="h-9 w-full rounded border border-line bg-surface-sunken px-2.5 text-sm text-ink focus:border-accent focus:outline-none"
          value={managerId}
          onChange={(event) => {
            setManagerId(event.target.value);
          }}
        >
          <option value="">No manager</option>
          {(directory.data?.members ?? [])
            .filter((candidate) => candidate.userId !== member.userId)
            .map((candidate) => (
              <option key={candidate.userId} value={candidate.userId}>
                {displayName({ name: candidate.displayName, email: candidate.email })}
              </option>
            ))}
        </select>
      </Field>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={setManager.isPending}
          onClick={() => {
            setManager.mutate({
              userId: member.userId,
              managerUserId: managerId === '' ? null : managerId,
            });
          }}
        >
          Save
        </Button>
        {jobTitle.trim() !== (member.jobTitle ?? '') ||
        department.trim() !== (member.department ?? '') ||
        workPhone.trim() !== (member.workPhone ?? '') ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={saveFacts.isPending}
            onClick={() => {
              saveFacts.mutate({
                userId: member.userId,
                jobTitle: jobTitle.trim() === '' ? null : jobTitle.trim(),
                department: department.trim() === '' ? null : department.trim(),
                workPhone: workPhone.trim() === '' ? null : workPhone.trim(),
              });
            }}
          >
            {saveFacts.isPending ? 'Saving…' : 'Save details'}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
