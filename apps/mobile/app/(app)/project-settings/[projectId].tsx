import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectIdSchema, type StatusCategory } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import {
  PROJECTS_QUERY_KEY,
  LABEL_PALETTE,
  labelsQueryKey,
  statusesQueryKey,
  fieldsQueryKey,
  allFieldsQueryKey,
  type LabelSummary,
  type StatusSummary,
  type CustomField,
} from '../../../src/lib/work.js';

/**
 * Everything about a project that is not a card — ported from
 * `apps/web/src/features/work/project-settings-page.tsx`. Same routes, same
 * split: all of it is `project:update` server-side, because every control
 * here changes the vocabulary every card in the project is expressed in;
 * filling one in on a card is `card:update` and lives in the card panel
 * instead (`card/[cardId].tsx`'s own label/field creation).
 *
 * **Boards are deliberately NOT a section here**, unlike web's single page.
 * `project/[projectId].tsx` is already this app's "browse and create
 * boards" screen — this screen instead adds the RENAME and ARCHIVE
 * controls that screen was missing, right on its own rows, rather than
 * building a second Boards list here that would show the same boards under
 * a different query and invite the two going out of sync. A "Settings"
 * link on that screen reaches this one for everything else.
 *
 * **No create form for labels or custom fields, matching web exactly.**
 * Both are minted from a card's detail panel the first time one is needed
 * (`card/[cardId].tsx` already does this on mobile); a project-level "new
 * label" box here would invite naming vocabulary nobody has a card for
 * yet. This screen EDITS the vocabulary that use already produced.
 * Statuses are the one exception — a board grouped by status needs the
 * columns to exist before a card can be dragged into one, so this is the
 * only section with a genuine create.
 *
 * **Labels and statuses are deleted for real; fields are archived.** A
 * label or status holds no content of its own — removing it un-tags or
 * un-classifies cards and destroys nothing anyone wrote, so an archived one
 * would be a restorable nothing cluttering the vocabulary forever. A field
 * can hold real values someone entered, so it is archived instead —
 * archived ones stay listed here (and only here) so they can be restored.
 *
 * **`Alert.alert` confirms the three genuinely irreversible or
 * high-consequence actions** — archiving the project (it also navigates
 * away), and deleting a label or status (a real delete, and the card count
 * in the message is the decision, exactly as `ConfirmButton`'s own label
 * is on web). Renaming, recoloring, and archiving/restoring a field are
 * left unconfirmed, matching this app's own established convention
 * elsewhere (`card/[cardId].tsx`'s checklist and item deletes, `org-
 * settings.tsx`'s member removal) for actions that are either reversible
 * or genuinely small.
 */
export default function ProjectSettingsScreen() {
  const params = useLocalSearchParams<{ projectId: string }>();
  const parsedProjectId = ProjectIdSchema.safeParse(params.projectId);

  if (!parsedProjectId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This project link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <ProjectSettingsContent projectId={parsedProjectId.data} />;
}

function ProjectSettingsContent({
  projectId,
}: {
  projectId: ReturnType<typeof ProjectIdSchema.parse>;
}) {
  const paddingTop = useTopInset();

  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });
  const project = projects.data?.find((entry) => entry.projectId === projectId);

  if (projects.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  if (projects.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(projects.error)?.error.message ?? "Couldn't load this project."}
        </Text>
        <BackButton />
      </View>
    );
  }

  if (project === undefined) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          No such project. It may have been archived, or belong to another organization.
        </Text>
        <BackButton />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { paddingTop }]} contentContainerStyle={styles.content}>
      <BackButton />
      <Text style={styles.screenTitle}>{project.name}</Text>
      <Text style={styles.screenKey}>{project.key}</Text>

      <ProjectDetails project={project} />
      <LabelSettings projectId={projectId} />
      <StatusSettings projectId={projectId} />
      <FieldSettings projectId={projectId} />
    </ScrollView>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

function ProjectDetails({
  project,
}: {
  readonly project: {
    projectId: string;
    name: string;
    key: string;
    description: string | null;
    capabilities: { readonly update: boolean; readonly delete: boolean };
  };
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  };

  const update = useMutation({
    mutationFn: () =>
      apiClient.work.projects.update.mutate({
        projectId: project.projectId,
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () =>
      apiClient.work.projects.archive.mutate({ projectId: project.projectId, archived: true }),
    onSuccess: async () => {
      await refresh();
      router.replace('/boards');
    },
  });

  const dirty =
    name.trim() !== project.name ||
    (description.trim() === '' ? null : description.trim()) !== project.description;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Project</Text>
      <TextInput
        value={name}
        editable={project.capabilities.update}
        onChangeText={setName}
        placeholder="Project name"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
      />
      <TextInput
        value={description}
        editable={project.capabilities.update}
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
      />
      {/* The key cannot be changed — it is baked into every card number
          already issued (WEB-142), including ones already pasted into chat
          messages and commit titles. Changing it would silently orphan
          all of them. */}
      <Text style={styles.sectionHint}>
        The project key ({project.key}) cannot be changed — it is part of every card number already
        issued.
      </Text>

      <View style={styles.rowBetween}>
        {project.capabilities.update && name.trim() !== '' && dirty && (
          <Pressable
            style={styles.saveButton}
            disabled={update.isPending}
            onPress={() => {
              update.mutate();
            }}
          >
            {update.isPending ? (
              <ActivityIndicator color={colors.accentInk.hex} />
            ) : (
              <Text style={styles.saveButtonText}>Save</Text>
            )}
          </Pressable>
        )}
        {project.capabilities.delete && (
          <Pressable
            style={styles.dangerButton}
            disabled={archive.isPending}
            onPress={() => {
              Alert.alert(
                'Archive project?',
                `"${project.name}" will be hidden from everyone in the organization. You can restore it later from the archived projects list.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Archive and leave',
                    style: 'destructive',
                    onPress: () => {
                      archive.mutate();
                    },
                  },
                ],
              );
            }}
          >
            <Text style={styles.dangerButtonText}>Archive project</Text>
          </Pressable>
        )}
      </View>

      {update.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(update.error)?.error.message ?? 'Could not save this project.'}
        </Text>
      )}
      {archive.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(archive.error)?.error.message ?? 'Could not archive this project.'}
        </Text>
      )}
    </View>
  );
}

function ColorSwatchRow({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (color: string) => void;
}) {
  return (
    <View style={styles.swatchRow}>
      {LABEL_PALETTE.map((color) => (
        <Pressable
          key={color}
          accessibilityLabel={`Colour ${color}`}
          style={[
            styles.swatch,
            { backgroundColor: color },
            value === color && styles.swatchSelected,
          ]}
          onPress={() => {
            onChange(color);
          }}
        />
      ))}
    </View>
  );
}

function LabelSettings({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const labels = useQuery({
    queryKey: labelsQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.labels.list.query({ projectId })),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', color: LABEL_PALETTE[0] ?? '#6366f1' });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: labelsQueryKey(projectId) });
  };

  const update = useMutation({
    mutationFn: (input: { labelId: string; name: string; color: string }) =>
      apiClient.work.labels.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (labelId: string) => apiClient.work.labels.delete.mutate({ labelId }),
    onSuccess: refresh,
  });

  const confirmDelete = (label: LabelSummary): void => {
    Alert.alert(
      'Delete this label?',
      label.cardCount === 0
        ? `"${label.name}" is not on any card. This cannot be undone.`
        : `"${label.name}" will be removed from ${String(label.cardCount)} ${label.cardCount === 1 ? 'card' : 'cards'}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            remove.mutate(label.labelId);
          },
        },
      ],
    );
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Labels · {labels.data?.length ?? 0}</Text>
      <Text style={styles.sectionHint}>
        Labels are created from a card's detail panel, the first time one is needed. Deleting one
        removes it from every card carrying it and cannot be undone.
      </Text>

      {labels.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : labels.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(labels.error)?.error.message ?? "Couldn't load labels."}
        </Text>
      ) : labels.data.length === 0 ? (
        <Text style={styles.emptyHint}>No labels yet.</Text>
      ) : (
        labels.data.map((label) =>
          editing === label.labelId ? (
            <View key={label.labelId} style={styles.editForm}>
              <ColorSwatchRow
                value={draft.color}
                onChange={(color) => {
                  setDraft((current) => ({ ...current, color }));
                }}
              />
              <TextInput
                value={draft.name}
                onChangeText={(value) => {
                  setDraft((current) => ({ ...current, name: value }));
                }}
                style={styles.formInput}
              />
              <View style={styles.formActions}>
                <Pressable
                  style={styles.saveButton}
                  disabled={update.isPending || draft.name.trim() === ''}
                  onPress={() => {
                    update.mutate({
                      labelId: label.labelId,
                      name: draft.name.trim(),
                      color: draft.color,
                    });
                  }}
                >
                  {update.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.saveButtonText}>Save</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.cancelButton}
                  onPress={() => {
                    setEditing(null);
                  }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View key={label.labelId} style={styles.row}>
              <View style={[styles.swatchSmall, { backgroundColor: label.color }]} />
              <Text style={styles.rowLabel} numberOfLines={1}>
                {label.name}
              </Text>
              <Text style={styles.rowCount}>
                {label.cardCount} {label.cardCount === 1 ? 'card' : 'cards'}
              </Text>
              <Pressable
                onPress={() => {
                  setEditing(label.labelId);
                  setDraft({ name: label.name, color: label.color });
                }}
              >
                <Text style={styles.editText}>Edit</Text>
              </Pressable>
              <Pressable
                disabled={remove.isPending}
                onPress={() => {
                  confirmDelete(label);
                }}
              >
                <Text style={styles.dangerText}>Delete</Text>
              </Pressable>
            </View>
          ),
        )
      )}

      {update.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(update.error)?.error.message ?? 'Could not save this label.'}
        </Text>
      )}
      {remove.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(remove.error)?.error.message ?? 'Could not delete this label.'}
        </Text>
      )}
    </View>
  );
}

const STATUS_CATEGORIES: readonly StatusCategory[] = ['not_started', 'active', 'done'];
const STATUS_CATEGORY_LABEL: Readonly<Record<StatusCategory, string>> = {
  not_started: 'Not started',
  active: 'Active',
  done: 'Done',
};

interface StatusDraft {
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: string;
  readonly isDefault: boolean;
}

const EMPTY_STATUS_DRAFT: StatusDraft = {
  name: '',
  category: 'not_started',
  color: LABEL_PALETTE[0] ?? '#6366f1',
  isDefault: false,
};

function StatusForm({
  draft,
  setDraft,
  onSubmit,
  submitLabel,
  pending,
  onCancel,
}: {
  readonly draft: StatusDraft;
  readonly setDraft: (next: StatusDraft) => void;
  readonly onSubmit: () => void;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly onCancel?: () => void;
}) {
  return (
    <View style={styles.editForm}>
      <ColorSwatchRow
        value={draft.color}
        onChange={(color) => {
          setDraft({ ...draft, color });
        }}
      />
      <TextInput
        value={draft.name}
        onChangeText={(value) => {
          setDraft({ ...draft, name: value });
        }}
        placeholder="Status name"
        placeholderTextColor={colors.inkFaint.hex}
        style={styles.formInput}
      />
      <View style={styles.roleRow}>
        {STATUS_CATEGORIES.map((category) => (
          <Pressable
            key={category}
            style={[styles.roleChip, draft.category === category && styles.roleChipActive]}
            onPress={() => {
              setDraft({ ...draft, category });
            }}
          >
            <Text
              style={[
                styles.roleChipText,
                draft.category === category && styles.roleChipTextActive,
              ]}
            >
              {STATUS_CATEGORY_LABEL[category]}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        style={styles.checkboxRow}
        onPress={() => {
          setDraft({ ...draft, isDefault: !draft.isDefault });
        }}
      >
        <View style={[styles.checkboxBox, draft.isDefault && styles.checkboxBoxOn]}>
          {draft.isDefault && <Text style={styles.checkboxCheck}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>Default for new cards</Text>
      </Pressable>
      <View style={styles.formActions}>
        <Pressable
          style={styles.saveButton}
          disabled={pending || draft.name.trim() === ''}
          onPress={onSubmit}
        >
          {pending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.saveButtonText}>{submitLabel}</Text>
          )}
        </Pressable>
        {onCancel !== undefined && (
          <Pressable style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function StatusSettings({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const statuses = useQuery({
    queryKey: statusesQueryKey(projectId),
    queryFn: async () => wire(await apiClient.work.statuses.list.query({ projectId })),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<StatusDraft>(EMPTY_STATUS_DRAFT);
  const [editDraft, setEditDraft] = useState<StatusDraft>(EMPTY_STATUS_DRAFT);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: statusesQueryKey(projectId) });
  };

  const create = useMutation({
    mutationFn: (input: StatusDraft) =>
      apiClient.work.statuses.create.mutate({ projectId, ...input }),
    onSuccess: async () => {
      setCreateDraft(EMPTY_STATUS_DRAFT);
      await refresh();
    },
  });

  const update = useMutation({
    mutationFn: (input: StatusDraft & { statusId: string }) =>
      apiClient.work.statuses.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (statusId: string) => apiClient.work.statuses.delete.mutate({ statusId }),
    onSuccess: refresh,
  });

  const confirmDelete = (status: StatusSummary): void => {
    Alert.alert(
      'Delete this status?',
      status.cardCount === 0
        ? `"${status.name}" is not used by any card. This cannot be undone.`
        : `${String(status.cardCount)} ${status.cardCount === 1 ? 'card' : 'cards'} using "${status.name}" will lose that status (the cards themselves are kept). This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            remove.mutate(status.statusId);
          },
        },
      ],
    );
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Statuses · {statuses.data?.length ?? 0}</Text>
      <Text style={styles.sectionHint}>
        What a board grouped by status shows as columns. The default is where a new card lands when
        nothing else was chosen.
      </Text>

      {editing === null && (
        <StatusForm
          draft={createDraft}
          setDraft={setCreateDraft}
          onSubmit={() => {
            create.mutate(createDraft);
          }}
          submitLabel="Add status"
          pending={create.isPending}
        />
      )}
      {create.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(create.error)?.error.message ?? 'Could not create this status.'}
        </Text>
      )}

      {statuses.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : statuses.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(statuses.error)?.error.message ?? "Couldn't load statuses."}
        </Text>
      ) : statuses.data.length === 0 ? (
        <Text style={styles.emptyHint}>No statuses yet.</Text>
      ) : (
        statuses.data.map((status) =>
          editing === status.statusId ? (
            <StatusForm
              key={status.statusId}
              draft={editDraft}
              setDraft={setEditDraft}
              onSubmit={() => {
                update.mutate({ statusId: status.statusId, ...editDraft });
              }}
              submitLabel="Save"
              pending={update.isPending}
              onCancel={() => {
                setEditing(null);
              }}
            />
          ) : (
            <View key={status.statusId} style={styles.row}>
              <View style={[styles.swatchSmall, { backgroundColor: status.color }]} />
              <Text style={styles.rowLabel} numberOfLines={1}>
                {status.name}
                {status.isDefault ? ' · default' : ''}
              </Text>
              <Text style={styles.rowCount}>{STATUS_CATEGORY_LABEL[status.category]}</Text>
              <Pressable
                onPress={() => {
                  setEditing(status.statusId);
                  setEditDraft({
                    name: status.name,
                    category: status.category,
                    color: status.color,
                    isDefault: status.isDefault,
                  });
                }}
              >
                <Text style={styles.editText}>Edit</Text>
              </Pressable>
              <Pressable
                disabled={remove.isPending}
                onPress={() => {
                  confirmDelete(status);
                }}
              >
                <Text style={styles.dangerText}>Delete</Text>
              </Pressable>
            </View>
          ),
        )
      )}

      {update.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(update.error)?.error.message ?? 'Could not save this status.'}
        </Text>
      )}
      {remove.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(remove.error)?.error.message ?? 'Could not delete this status.'}
        </Text>
      )}
    </View>
  );
}

function FieldSettings({ projectId }: { readonly projectId: string }) {
  const queryClient = useQueryClient();
  const fields = useQuery({
    queryKey: allFieldsQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.fields.list.query({ projectId, includeArchived: true })),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  const refresh = async (): Promise<void> => {
    // The base key, not the 'all' variant — invalidateQueries matches by
    // prefix, so this also refreshes the live-only read a card panel holds.
    await queryClient.invalidateQueries({ queryKey: fieldsQueryKey(projectId) });
  };

  const rename = useMutation({
    mutationFn: (input: { fieldId: string; name: string }) =>
      apiClient.work.fields.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const setArchived = useMutation({
    mutationFn: (input: { fieldId: string; archived: boolean }) =>
      apiClient.work.fields.archive.mutate(input),
    onSuccess: refresh,
  });

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Custom fields · {fields.data?.length ?? 0}</Text>
      <Text style={styles.sectionHint}>
        A field's type is fixed once created. Archiving hides a field without discarding the values
        already entered on existing cards — archived fields stay listed here, the only place they
        can be restored.
      </Text>

      {fields.isPending ? (
        <ActivityIndicator color={colors.accent.hex} />
      ) : fields.isError ? (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(fields.error)?.error.message ?? "Couldn't load custom fields."}
        </Text>
      ) : fields.data.length === 0 ? (
        <Text style={styles.emptyHint}>
          No custom fields yet. Fields are created from a card's detail panel.
        </Text>
      ) : (
        fields.data.map((field: CustomField) =>
          editing === field.fieldId ? (
            <View key={field.fieldId} style={styles.editForm}>
              <TextInput value={name} onChangeText={setName} style={styles.formInput} />
              <View style={styles.formActions}>
                <Pressable
                  style={styles.saveButton}
                  disabled={rename.isPending || name.trim() === ''}
                  onPress={() => {
                    rename.mutate({ fieldId: field.fieldId, name: name.trim() });
                  }}
                >
                  {rename.isPending ? (
                    <ActivityIndicator color={colors.accentInk.hex} />
                  ) : (
                    <Text style={styles.saveButtonText}>Save</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.cancelButton}
                  onPress={() => {
                    setEditing(null);
                  }}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View key={field.fieldId} style={styles.row}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {field.name}
                {field.archivedAt !== null ? ' · archived' : ''}
              </Text>
              <Text style={styles.rowCount}>{field.type}</Text>
              <Pressable
                onPress={() => {
                  setEditing(field.fieldId);
                  setName(field.name);
                }}
              >
                <Text style={styles.editText}>Rename</Text>
              </Pressable>
              <Pressable
                disabled={setArchived.isPending}
                onPress={() => {
                  setArchived.mutate({
                    fieldId: field.fieldId,
                    archived: field.archivedAt === null,
                  });
                }}
              >
                <Text style={styles.editText}>
                  {field.archivedAt === null ? 'Archive' : 'Restore'}
                </Text>
              </Pressable>
            </View>
          ),
        )
      )}

      {rename.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(rename.error)?.error.message ?? 'Could not rename this field.'}
        </Text>
      )}
      {setArchived.isError && (
        <Text style={styles.sectionError} accessibilityRole="alert">
          {apiErrorOf(setArchived.error)?.error.message ?? 'Could not update this field.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  screenTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  screenKey: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.inkMuted.hex,
    marginBottom: 8,
  },
  section: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex + '60',
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  sectionError: {
    fontSize: 12,
    color: colors.danger.hex,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingVertical: 6,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  saveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  cancelButtonText: {
    color: colors.inkMuted.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  dangerButton: {
    borderWidth: 1,
    borderColor: colors.danger.hex + '40',
    borderRadius: radiusCard,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.danger.hex + '08',
  },
  dangerButtonText: {
    color: colors.danger.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  editForm: {
    gap: 8,
    backgroundColor: colors.surfaceRaised.hex,
    borderRadius: radiusCard,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.line.hex + '60',
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  swatchSelected: {
    borderColor: colors.ink.hex,
  },
  swatchSmall: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  roleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  roleChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  roleChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  roleChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  roleChipTextActive: {
    color: colors.accentInk.hex,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkboxBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
  checkboxBoxOn: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  checkboxCheck: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '700',
  },
  checkboxLabel: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowCount: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  editText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  dangerText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
