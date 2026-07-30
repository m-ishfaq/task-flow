import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { keys, resetCache } from '../../lib/query.js';
import { Button, Empty, Field, Input, Spinner } from '../../components/primitives.js';
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
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (orgs.isError) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorView error={orgs.error} title="Could not load your organizations" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold text-ink">Choose an organization</h1>

      {orgs.data.length === 0 ? (
        <Empty
          title="You are not a member of any organization yet"
          description="Create one to get started. You become its owner."
        />
      ) : (
        <ul className="space-y-1">
          {orgs.data.map((org) => (
            <li key={org.orgId}>
              <button
                type="button"
                onClick={() => {
                  choose(org.orgId as OrgId);
                }}
                className="flex w-full items-center justify-between rounded border border-line bg-surface-raised px-3 py-2 text-left hover:bg-surface-hover"
              >
                <span className="text-sm text-ink">{org.name}</span>
                <span className="text-[11px] text-ink-faint">{org.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <CreateOrgForm onCreated={choose} />
    </div>
  );
}

function CreateOrgForm({ onCreated }: { readonly onCreated: (orgId: OrgId) => void }) {
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
      className="space-y-3 border-t border-line pt-6"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <h2 className="text-sm font-medium text-ink">Create an organization</h2>

      <Field label="Name" htmlFor="org-name">
        <Input
          id="org-name"
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
        <Input id="org-slug" {...register('slug', { required: true })} />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <Button type="submit" variant="primary" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create'}
      </Button>
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
