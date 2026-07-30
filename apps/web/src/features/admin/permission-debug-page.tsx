import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, RESOURCE_TYPES, type Permission, type ResourceType } from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { wire } from '../../lib/wire.js';
import { cn } from '../../lib/cn.js';
import { Button, Field, Input, Spinner } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { membersQuery } from '../org/api.js';

/**
 * The permission debug page (§10.7).
 *
 * Deferred from Phase 2 with the note "the decision trace ships now, its UI with
 * the app that renders it". This is that UI.
 *
 * ## Why it renders the server's trace instead of computing anything
 *
 * The whole value of this page is that it answers "why can this person do this?"
 * with the SAME evaluation that runs on every request. `tenancy.authz.explain`
 * calls `can()` and returns its trace; this component formats it and adds
 * nothing. A page that re-derived the answer in the browser would be a second
 * authorization model — and the one users trust would be the one that is never
 * enforced, which is the exact failure §8.2 exists to prevent.
 *
 * ## Why it is behind `audit:read`
 *
 * It reports another user's access, which is precisely what an attacker wants
 * before choosing a target. Owner and Admin only. The route is enforced on the
 * server; this page will simply show the FORBIDDEN it gets back.
 */

const LAYER_NAMES: Readonly<Record<number, string>> = {
  1: 'Membership',
  2: 'Role',
  3: 'Relationship tuples',
  4: 'Restrictions',
};

export function PermissionDebugPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const members = useQuery(membersQuery(orgId));

  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<Permission>('card:update');
  const [resourceType, setResourceType] = useState<ResourceType | ''>('');
  const [resourceId, setResourceId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const input = {
    userId,
    permission,
    resourceType: resourceType === '' ? null : resourceType,
    resourceId: resourceId.trim() === '' ? null : resourceId.trim(),
  };

  const explanation = useQuery({
    queryKey: keys.explain(orgId, submitted ?? ''),
    queryFn: async () =>
      wire(
        await api.tenancy.authz.explain.query({
          ...input,
          userId: input.userId,
        }),
      ),
    enabled: submitted !== null && userId !== '',
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Permission debugger</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Runs the real policy engine and shows every layer it consulted. This is the same{' '}
          <code className="text-xs">can()</code> that decides every request.
        </p>
      </div>

      <form
        className="grid gap-3 rounded border border-line bg-surface-raised p-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(JSON.stringify(input));
        }}
      >
        <Field label="User" htmlFor="debug-user">
          <select
            id="debug-user"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
            }}
            className="h-9 w-full rounded border border-line bg-surface-sunken px-2 text-sm text-ink"
          >
            <option value="">Select a member…</option>
            {(members.data ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.email} ({member.role})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Permission" htmlFor="debug-permission">
          <select
            id="debug-permission"
            value={permission}
            onChange={(event) => {
              setPermission(event.target.value as Permission);
            }}
            className="h-9 w-full rounded border border-line bg-surface-sunken px-2 text-sm text-ink"
          >
            {PERMISSIONS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Resource type"
          htmlFor="debug-resource-type"
          hint="Leave blank to ask about the organization as a whole."
        >
          <select
            id="debug-resource-type"
            value={resourceType}
            onChange={(event) => {
              setResourceType(event.target.value as ResourceType | '');
            }}
            className="h-9 w-full rounded border border-line bg-surface-sunken px-2 text-sm text-ink"
          >
            <option value="">(none)</option>
            {RESOURCE_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Resource id" htmlFor="debug-resource-id">
          <Input
            id="debug-resource-id"
            placeholder="UUID"
            value={resourceId}
            className="font-mono text-xs"
            onChange={(event) => {
              setResourceId(event.target.value);
            }}
          />
        </Field>

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={userId === ''}>
            Explain
          </Button>
        </div>
      </form>

      {explanation.isFetching && <Spinner />}

      {explanation.isError && (
        <ErrorView error={explanation.error} title="Could not evaluate that permission" />
      )}

      {explanation.isSuccess && (
        <div className="space-y-4">
          <div
            className={cn(
              'rounded border px-3 py-2',
              explanation.data.allowed
                ? 'border-success/40 bg-success/10'
                : 'border-danger/40 bg-danger/10',
            )}
          >
            <p className="text-sm font-medium text-ink">
              {explanation.data.allowed ? 'Allowed' : 'Denied'} — role{' '}
              <span className="font-mono">{explanation.data.role}</span>
            </p>
            <p className="text-xs text-ink-muted">{explanation.data.reason}</p>
          </div>

          <div>
            <h2 className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
              Decision trace
            </h2>
            <ol className="space-y-1">
              {explanation.data.trace.map((step, index) => (
                <li
                  key={`${String(step.layer)}-${step.rule}-${String(index)}`}
                  className="grid grid-cols-[7rem_5rem_1fr] items-baseline gap-2 rounded border border-line px-2 py-1 text-xs"
                >
                  <span className="text-ink-faint">
                    {LAYER_NAMES[step.layer] ?? `Layer ${String(step.layer)}`}
                  </span>
                  <span
                    className={cn(
                      'font-medium',
                      step.outcome === 'allow'
                        ? 'text-success'
                        : step.outcome === 'deny'
                          ? 'text-danger'
                          : 'text-ink-muted',
                    )}
                  >
                    {step.outcome}
                  </span>
                  <span className="text-ink">
                    {step.rule}
                    {step.detail !== undefined && (
                      <span className="text-ink-faint"> — {step.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <h2 className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
              As the server formats it
            </h2>
            {/* `formatted` is a plain string produced by `formatTrace()` on the
                server. Rendered as text in a <pre>, never as markup — there is
                no HTML anywhere in this app, and `dangerouslySetInnerHTML` is a
                lint error workspace-wide. */}
            <pre className="overflow-x-auto rounded border border-line bg-surface-sunken p-2 font-mono text-[11px] text-ink-muted">
              {explanation.data.formatted}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
