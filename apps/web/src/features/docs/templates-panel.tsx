import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageId, PageTemplateId, SpaceId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import { Button, ConfirmButton, FocusOnMountInput } from '../../components/primitives.js';
import {
  createTemplate,
  deleteTemplate,
  invalidatePageTemplates,
  pageTemplatesQuery,
} from './api.js';

/**
 * Page templates (ai/phase-6-docs.md §5, Wave 4) — "save this page's
 * content as a space's reusable starting point", per `template.service.ts`'s
 * own header. `space:manage`/`space:read` cover create/delete/list with no
 * new permission, so — same convention as everywhere else in this app
 * (CLAUDE.md §8.2) — every control here is shown unconditionally and the
 * server answers FORBIDDEN for a caller without `space:manage`.
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
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Templates</h3>

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
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSaving(true);
          }}
        >
          Save this page as a template
        </Button>
      )}

      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((template) => (
            <li
              key={template.templateId}
              className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-hover"
            >
              <span className="truncate text-ink-muted">{template.name}</span>
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete template"
                size="sm"
                disabled={remove.isPending}
                onConfirm={() => {
                  remove.mutate(template.templateId as PageTemplateId);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
