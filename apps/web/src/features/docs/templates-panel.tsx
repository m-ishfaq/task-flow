import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageId, PageTemplateId, SpaceId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import {
  Button,
  ConfirmButton,
  FocusOnMountInput,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  createTemplate,
  deleteTemplate,
  invalidatePageTemplates,
  pageTemplatesQuery,
  spacesQuery,
} from './api.js';

/**
 * Page templates (ai/phase-6-docs.md §5, Wave 4) — "save this page's
 * content as a space's reusable starting point", per `template.service.ts`'s
 * own header. `space:manage`/`space:read` cover create/delete/list with no
 * new permission. Save/delete are gated on `spaces.list`'s own per-space
 * `capabilities.manage` (Phase 15 §1's sweep) — refetched here via
 * `spacesQuery`, which `docs-page.tsx`'s tree panel already keeps warm, so
 * this is normally a cache hit rather than a second request.
 *
 * `docs-page.tsx`'s `CreatePageForm` is the OTHER half — picking a template
 * when creating a page — and queries the same `pageTemplatesQuery` directly
 * rather than through this file, since it needs only the list, not the
 * save/delete controls this panel renders.
 */

export function TemplatesPanel({
  orgId,
  spaceId,
  pageId,
}: {
  readonly orgId: string;
  readonly spaceId: SpaceId;
  readonly pageId: PageId;
}) {
  const templates = useQuery(pageTemplatesQuery(orgId, spaceId));
  const canManage =
    useQuery(spacesQuery(orgId)).data?.find((space) => space.spaceId === spaceId)?.capabilities
      .manage === true;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  const save = useMutation({
    mutationFn: () => createTemplate({ pageId, name }),
    onSuccess: () => {
      invalidatePageTemplates(queryClient, orgId, spaceId);
      setSaving(false);
      setName('');
    },
    onError: (error) => {
      toast.failure('The template was not saved', error);
    },
  });

  const remove = useMutation({
    mutationFn: (templateId: PageTemplateId) => deleteTemplate({ templateId }),
    onSuccess: () => {
      invalidatePageTemplates(queryClient, orgId, spaceId);
    },
    onError: (error) => {
      toast.failure('The template was not deleted', error);
    },
  });

  const list = templates.data ?? [];

  return (
    <div className="space-y-2">
      <h3 className="text-[13px] font-semibold text-ink">Templates</h3>

      {saving ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length === 0) return;
            save.mutate();
          }}
          className="flex gap-1.5"
        >
          <FocusOnMountInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Template name"
            className="h-7 flex-1 text-xs"
          />
          <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setSaving(false);
              setName('');
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        canManage && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSaving(true);
            }}
          >
            Save this page as a template
          </Button>
        )
      )}

      {/* `templates.data ?? []` above made "still loading" and "no templates
          exist" the same empty list — ai/phase-6.5-ui-polish.md Wave 1's audit
          finding. `isPending`/`isError` are checked ahead of the list so a
          slow fetch doesn't read as "this space has none". */}
      {templates.isPending && <SkeletonRows rows={2} className="h-6" />}
      {templates.isError && <ErrorView error={templates.error} title="Templates didn't load" />}

      {!templates.isPending && !templates.isError && list.length > 0 && (
        <ul className="space-y-1">
          {list.map((template) => (
            <li
              key={template.templateId}
              className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-surface-hover"
            >
              <span className="truncate text-ink-muted">{template.name}</span>
              {canManage && (
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Delete template"
                  size="sm"
                  disabled={remove.isPending}
                  onConfirm={() => {
                    remove.mutate(template.templateId as PageTemplateId);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
