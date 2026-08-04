import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { keys, resetCache } from '../../lib/query.js';
import { Badge, Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { orgsQuery } from './api.js';

/**
 * Choosing — or creating — an organization.
 *
 * This is the one page that works with no org selected, which is why
 * `tenancy.orgs.list` is a `selfRoute` rather than a permissioned one: asking
 * "which orgs am I in?" cannot require having already answered it. On the server
 * that query runs under `withUserScope`, whose two policies are `FOR SELECT`
 * with no `WITH CHECK` — see the Phase 2 notes in CLAUDE.md.
 *
 * ## Two states, and they need opposite layouts
 *
 * Someone with no organizations needs a form; someone with four needs a list and
 * would rather not scroll past a form to reach it. The create panel is therefore
 * COLLAPSED behind a button when orgs exist and expanded when none do — same
 * component, and the decision is made from the data rather than by the person
 * arriving on a page that is mostly empty either way.
 */

interface CreateValues {
  name: string;
  slug: string;
}

export function OrgPickerPage() {
  const orgs = useQuery(orgsQuery());
  const selectOrg = useSession((state) => state.selectOrg);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const choose = (orgId: OrgId) => {
    selectOrg(orgId);
    resetCache(queryClient);
    void navigate({ to: '/projects' });
  };

  if (orgs.isPending) {
    return (
      <div className="mx-auto w-full max-w-lg p-6">
        <SkeletonRows rows={3} className="*:h-16" />
      </div>
    );
  }

  if (orgs.isError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorView error={orgs.error} title="Could not load your organizations" />
      </div>
    );
  }

  const isEmpty = orgs.data.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">
          {isEmpty ? 'Create your first organization' : 'Choose an organization'}
        </h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          {isEmpty
            ? 'An organization owns its own projects, members and audit trail. You become its owner.'
            : 'Everything you see afterwards belongs to the one you pick.'}
        </p>
      </div>

      <CreateOrgPanel startOpen={isEmpty} onCreated={choose} />

      {!isEmpty && (
        <ul className="space-y-2">
          {orgs.data.map((org) => (
            <li key={org.orgId}>
              <button
                type="button"
                onClick={() => {
                  choose(org.orgId as OrgId);
                }}
                className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface-raised p-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-hover"
              >
                <OrgMark name={org.name} />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{org.name}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-faint">
                    {org.slug}
                  </span>
                </span>

                <Badge>{org.role}</Badge>
                <span
                  aria-hidden="true"
                  className="text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-muted"
                >
                  &rarr;
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The square with an initial in it.
 *
 * Deliberately not `Avatar`: that one hues from a USER id and is documented as
 * keeping one person one colour everywhere. An org is not a person, and feeding
 * an org id into it would mint a second meaning for the same visual language.
 */
function OrgMark({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-sm font-semibold text-ink-muted"
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function CreateOrgPanel({
  startOpen,
  onCreated,
}: {
  readonly startOpen: boolean;
  readonly onCreated: (orgId: OrgId) => void;
}) {
  const [open, setOpen] = useState(startOpen);

  if (!open) {
    return (
      <Button
        variant="ghost"
        className="justify-start border border-dashed border-line text-ink-muted hover:text-ink"
        onClick={() => {
          setOpen(true);
        }}
      >
        + New organization
      </Button>
    );
  }

  return (
    <CreateOrgForm
      onCreated={onCreated}
      onCancel={
        startOpen
          ? null
          : () => {
              setOpen(false);
            }
      }
    />
  );
}

function CreateOrgForm({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (orgId: OrgId) => void;
  /** Null when there is nothing to go back to — a first org is not optional. */
  readonly onCancel: (() => void) | null;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, setValue } = useForm<CreateValues>({
    defaultValues: { name: '', slug: '' },
  });

  const create = useMutation({
    mutationFn: (values: CreateValues) => api.tenancy.orgs.create.mutate(values),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.orgs() });
      onCreated(result.orgId as OrgId);
    },
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed border-line bg-surface-sunken/60 p-3"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <Field label="Name" htmlFor="org-name">
        <Input
          id="org-name"
          placeholder="Acme Corp"
          {...register('name', {
            required: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              /* The slug follows the name until someone edits it. Derived on
                 the client purely as a convenience — the server has its own
                 `Slug` schema and a unique index, and both still decide. */
              setValue('slug', slugify(event.target.value), { shouldDirty: false });
            },
          })}
        />
      </Field>

      <Field
        label="Slug"
        htmlFor="org-slug"
        hint="Used in URLs. Derived from the name; edit it if you want something else."
      >
        <Input id="org-slug" className="font-mono" {...register('slug', { required: true })} />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
        {onCancel !== null && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
