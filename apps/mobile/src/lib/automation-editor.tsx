import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { apiErrorOf } from './trpc-client.js';
import { MEMBERS_QUERY_KEY } from './org-settings.js';
import { CHANNELS_QUERY_KEY } from './chat.js';
import { PHONE_NUMBERS_QUERY_KEY } from './telephony.js';
import { TelephonyContactPicker } from './telephony-contact-picker.js';
import {
  PROJECTS_QUERY_KEY,
  boardsQueryKey,
  listsQueryKey,
  statusesQueryKey,
  labelsQueryKey,
} from './work.js';
import {
  ARGUMENTS,
  AUTOMATIONS_QUERY_KEY,
  EDITOR_TRIGGER_OPTIONS,
  actionsComplete,
  blankAction,
  draftsFrom,
  needsProject,
  offeredActions,
  triggerLabel,
  type ActionDraft,
  type ArgumentSpec,
  type AutomationSummary,
} from './automation.js';

/**
 * The rule builder — create and edit, ported from
 * `apps/web/src/features/automation/automations-page.tsx`'s `RuleEditor`
 * and `action-pickers.tsx`. `automation.ts`'s own header states the two
 * real boundaries this editor draws (no condition, no webhook/connector
 * actions) — this file is where those boundaries are actually enforced in
 * the UI, not just documented.
 *
 * ## Every picker is a query this app already had
 *
 * The first version of this feature (had it existed) would have been a
 * text input per argument, asking someone to paste a UUID — nobody knows a
 * channel's id. Every picker below instead reuses a query some OTHER
 * screen already made real: `MemberField` reads the same
 * `tenancy.members.list` `org-settings.tsx` renders as a roster,
 * `ChannelField` the same `chat.channels.list` the Chat tab lists,
 * `PhoneNumberField` the same numbers `(tabs)/calls.tsx` already shows
 * owned, and `to` for `call.place`/`sms.send` reuses
 * `TelephonyContactPicker` UNCHANGED — the identical component the Calls
 * tab's dial pad uses, not a rebuild of the same idea. `List`/`Status`/
 * `Label` are the one genuinely new query shape (`work.boards.list` +
 * `work.lists.list` cascaded, `work.statuses.list`, `work.labels.list`),
 * because nothing before this queried them OUTSIDE a single project's own
 * screens.
 *
 * ## The project-scope problem, made visible rather than introduced
 *
 * Lists, statuses and labels are PROJECT vocabulary; a rule is org-wide.
 * `ProjectScopeField` only appears when an action actually needs one, and
 * the chosen project is a UI aid, never stored — the action carries the id
 * it resolved to, and the engine needs nothing else. That mismatch is
 * real and predates this file: an action naming project A's list simply
 * fails for a card in project B, and the run records it as a failed run,
 * not a save-time error. The picker makes the binding visible; it does
 * not remove it.
 *
 * ## `ListField` flattens two levels into one picker, unlike web
 *
 * Web renders one `<select>` per board, stacked, because an HTML form has
 * no cheap way to group options inside one dropdown. A bottom-sheet list
 * has no such limit, so this flattens every board's lists into ONE
 * picker with board-prefixed names ("Sprint board › Done") — one control
 * instead of guessing which of several stacked selects holds the list you
 * want, which is a real improvement this platform's own UI shape makes
 * possible rather than a corner cut.
 */

export function RuleEditor({
  initial,
  onDone,
  onCancel,
}: {
  /** Present when editing an existing rule; absent when creating one.
   *  Only ever passed for a rule `canEditOnMobile` has already approved —
   *  `automation.ts`'s own header states why nothing here re-checks that. */
  readonly initial?: AutomationSummary;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = initial !== undefined;

  const [name, setName] = useState(initial?.name ?? '');
  const [triggerEvent, setTriggerEvent] = useState(
    initial?.triggerEvent ?? EDITOR_TRIGGER_OPTIONS[0]?.event ?? '',
  );
  const [actions, setActions] = useState<ActionDraft[]>(() =>
    editing ? draftsFrom(initial.actions) : [blankAction('card.set_priority', 'a0')],
  );
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [triggerPickerOpen, setTriggerPickerOpen] = useState(false);

  const capabilities = useQuery({
    queryKey: ['automation.capabilities'],
    queryFn: () => apiClient.automation.capabilities.query({}),
  });
  const telephonyActionsEnabled = capabilities.data?.telephonyActionsEnabled ?? false;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: null,
        triggerEvent,
        // This editor never writes a condition — automation.ts's own
        // header states why (no field/operator vocabulary on native).
        // `initial?.condition` is not read here even when editing: this
        // component is only ever mounted for a rule `canEditOnMobile`
        // already confirmed has `condition === null`.
        condition: null,
        actions: actions.map((action) => action.value) as never,
        // Preserved, not reset — an edit must not silently re-enable a
        // rule someone deliberately turned off.
        enabled: initial?.enabled ?? true,
      };

      return editing
        ? apiClient.automation.update
            .mutate({ ...body, automationId: initial.automationId })
            .then(() => undefined)
        : apiClient.automation.create.mutate(body).then(() => undefined);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: AUTOMATIONS_QUERY_KEY });
      onDone();
    },
  });

  const showProjectScope = actions.some((action) => needsProject(action.value.type));

  return (
    <ScrollView style={styles.editor} contentContainerStyle={styles.editorContent}>
      <FieldLabel>Name</FieldLabel>
      <TextInput
        style={styles.textInput}
        value={name}
        onChangeText={setName}
        maxLength={120}
        placeholder="Notify the team when something ships"
        placeholderTextColor={colors.inkFaint.hex}
      />

      <FieldLabel>When</FieldLabel>
      <Pressable
        style={styles.pickerField}
        onPress={() => {
          setTriggerPickerOpen(true);
        }}
      >
        <Text style={styles.pickerFieldValue}>{triggerLabel(triggerEvent)}</Text>
      </Pressable>
      <SelectModal
        open={triggerPickerOpen}
        title="When"
        pending={false}
        options={EDITOR_TRIGGER_OPTIONS.map((option) => ({ id: option.event, name: option.label }))}
        emptyText="No triggers"
        onSelect={(event) => {
          setTriggerEvent(event);
          setTriggerPickerOpen(false);
        }}
        onClose={() => {
          setTriggerPickerOpen(false);
        }}
      />

      {showProjectScope && (
        <>
          <FieldLabel>Project (for list, status and label choices)</FieldLabel>
          <ProjectScopeField value={scopeProjectId} onChange={setScopeProjectId} />
          <Text style={styles.fieldHint}>
            Those actions only apply to cards in this project — a card from another project records
            a failed run.
          </Text>
        </>
      )}

      <FieldLabel>Then</FieldLabel>
      <View style={styles.actionsList}>
        {actions.map((action, index) => (
          <ActionRow
            key={action.key}
            action={action}
            telephonyActionsEnabled={telephonyActionsEnabled}
            projectId={scopeProjectId}
            onChange={(next) => {
              setActions(actions.map((item, i) => (i === index ? next : item)));
            }}
            onRemove={
              actions.length > 1
                ? () => {
                    setActions(actions.filter((_, i) => i !== index));
                  }
                : undefined
            }
          />
        ))}
        {actions.length < 10 && (
          <Pressable
            style={styles.addActionButton}
            onPress={() => {
              setActions([...actions, blankAction('card.set_priority', `a${String(Date.now())}`)]);
            }}
          >
            <Text style={styles.addActionButtonText}>+ Add action</Text>
          </Pressable>
        )}
      </View>

      {save.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(save.error)?.error.message ?? 'This rule could not be saved.'}
        </Text>
      )}

      <View style={styles.formActions}>
        <Pressable
          style={[
            styles.primaryButton,
            (name.trim() === '' || !actionsComplete(actions) || save.isPending) &&
              styles.buttonDisabled,
          ]}
          disabled={name.trim() === '' || !actionsComplete(actions) || save.isPending}
          onPress={() => {
            save.mutate();
          }}
        >
          {save.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.primaryButtonText}>{editing ? 'Save changes' : 'Create rule'}</Text>
          )}
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      </View>
      {name.trim() !== '' && !actionsComplete(actions) && (
        <Text style={styles.fieldHint}>Finish choosing each action to save.</Text>
      )}
    </ScrollView>
  );
}

function ActionRow({
  action,
  telephonyActionsEnabled,
  projectId,
  onChange,
  onRemove,
}: {
  readonly action: ActionDraft;
  readonly telephonyActionsEnabled: boolean;
  readonly projectId: string | null;
  readonly onChange: (next: ActionDraft) => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const [typeOpen, setTypeOpen] = useState(false);
  const offered = offeredActions(telephonyActionsEnabled);
  const currentLabel =
    offered.find(([type]) => type === action.value.type)?.[1] ?? action.value.type;
  const fields = action.value as unknown as Record<string, string>;

  return (
    <View style={styles.actionRow}>
      <View style={styles.actionRowHeader}>
        <Pressable
          style={styles.actionTypeButton}
          onPress={() => {
            setTypeOpen(true);
          }}
        >
          <Text style={styles.actionTypeText} numberOfLines={1}>
            {currentLabel}
          </Text>
          <Text style={styles.actionTypeChevron}>▾</Text>
        </Pressable>
        {onRemove !== undefined && (
          <Pressable onPress={onRemove}>
            <Text style={styles.removeActionText}>Remove</Text>
          </Pressable>
        )}
      </View>

      {(ARGUMENTS[action.value.type] ?? []).map((spec) => (
        <ArgumentField
          key={spec.field}
          spec={spec}
          value={fields[spec.field] ?? ''}
          projectId={projectId}
          onChange={(value) => {
            onChange({ ...action, value: { ...action.value, [spec.field]: value } });
          }}
        />
      ))}

      <SelectModal
        open={typeOpen}
        title="Action type"
        pending={false}
        options={offered.map(([type, label]) => ({ id: type, name: label }))}
        emptyText="No action types available"
        onSelect={(type) => {
          onChange(blankAction(type, action.key));
          setTypeOpen(false);
        }}
        onClose={() => {
          setTypeOpen(false);
        }}
      />
    </View>
  );
}

function ArgumentField({
  spec,
  value,
  onChange,
  projectId,
}: {
  readonly spec: ArgumentSpec;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly projectId: string | null;
}) {
  switch (spec.kind) {
    case 'text':
      return (
        <View style={styles.argumentField}>
          <FieldLabel small>{spec.label}</FieldLabel>
          <TextInput
            style={styles.textInput}
            value={value}
            onChangeText={onChange}
            multiline
            maxLength={2000}
            placeholder={spec.label}
            placeholderTextColor={colors.inkFaint.hex}
          />
        </View>
      );
    case 'priority':
      return (
        <View style={styles.argumentField}>
          <FieldLabel small>{spec.label}</FieldLabel>
          <View style={styles.priorityChips}>
            {(['urgent', 'high', 'normal', 'low'] as const).map((priority) => (
              <Pressable
                key={priority}
                style={[styles.priorityChip, value === priority && styles.priorityChipActive]}
                onPress={() => {
                  onChange(priority);
                }}
              >
                <Text
                  style={[
                    styles.priorityChipText,
                    value === priority && styles.priorityChipTextActive,
                  ]}
                >
                  {priority}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      );
    case 'member':
      return <MemberField label={spec.label} value={value} onChange={onChange} />;
    case 'channel':
      return <ChannelField label={spec.label} value={value} onChange={onChange} />;
    case 'phoneNumber':
      return <PhoneNumberField label={spec.label} value={value} onChange={onChange} />;
    case 'phoneTarget':
      return (
        <View style={styles.argumentField}>
          <FieldLabel small>{spec.label}</FieldLabel>
          <TelephonyContactPicker value={value} onChange={onChange} />
        </View>
      );
    case 'list':
      return <ListField projectId={projectId} value={value} onChange={onChange} />;
    case 'status':
      return <StatusField projectId={projectId} value={value} onChange={onChange} />;
    case 'label':
      return <LabelField projectId={projectId} value={value} onChange={onChange} />;
    default:
      return null;
  }
}

function MemberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.members.list.query()),
  });

  return (
    <SelectField
      label={label}
      value={value}
      onChange={onChange}
      pending={members.isPending}
      options={(members.data ?? []).map((member) => ({
        id: member.userId,
        name: member.displayName ?? member.email,
      }))}
      emptyText="No members"
    />
  );
}

function ChannelField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const channels = useQuery({
    queryKey: CHANNELS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.chat.channels.list.query()),
  });

  return (
    <SelectField
      label={label}
      value={value}
      onChange={onChange}
      pending={channels.isPending}
      // DMs excluded — a rule posting into someone's direct message is
      // either a mistake or should be a notification instead, and the
      // channel a rule posts to should be one other people can see.
      options={(channels.data?.channels ?? [])
        .filter((channel) => channel.type !== 'dm' && channel.type !== 'group_dm')
        .map((channel) => ({ id: channel.channelId, name: `#${channel.name ?? 'channel'}` }))}
      emptyText="No channels"
    />
  );
}

function PhoneNumberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const numbers = useQuery({
    queryKey: PHONE_NUMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.telephony.numbers.list.query({})),
  });

  return (
    <SelectField
      label={label}
      value={value}
      onChange={onChange}
      pending={numbers.isPending}
      options={(numbers.data ?? []).map((number) => ({
        id: number.phoneNumberId,
        name: String(number.e164),
      }))}
      emptyText="No numbers owned yet — purchase one on the Calls tab"
    />
  );
}

function ProjectScopeField({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (value: string) => void;
}) {
  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.work.projects.list.query({ includeArchived: false })),
  });

  return (
    <SelectField
      label="Project"
      value={value ?? ''}
      onChange={onChange}
      pending={projects.isPending}
      options={(projects.data ?? []).map((project) => ({
        id: project.projectId,
        name: project.name,
      }))}
      emptyText="No projects"
    />
  );
}

/** Lists live under a board, which lives under a project — flattened into
 *  ONE board-prefixed picker rather than web's stacked per-board selects
 *  (see this file's own header). */
function ListField({
  projectId,
  value,
  onChange,
}: {
  readonly projectId: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const boards = useQuery({
    queryKey: projectId === null ? PROJECTS_QUERY_KEY : boardsQueryKey(projectId),
    queryFn: async () =>
      wire(
        await apiClient.work.boards.list.query({
          projectId: projectId ?? '',
          includeArchived: false,
        }),
      ),
    enabled: projectId !== null,
  });
  const liveBoards = (boards.data ?? []).filter((board) => board.archivedAt === null);

  const listQueries = useQueries({
    queries: liveBoards.map((board) => ({
      queryKey: listsQueryKey(board.boardId),
      queryFn: async () => wire(await apiClient.work.lists.list.query({ boardId: board.boardId })),
    })),
  });

  if (projectId === null) return <NeedsProjectHint label="List" />;

  const pending = boards.isPending || listQueries.some((query) => query.isPending);
  const options = liveBoards.flatMap((board, index) =>
    (listQueries[index]?.data ?? []).map((list) => ({
      id: list.listId,
      name: `${board.name} › ${list.name}`,
    })),
  );

  return (
    <SelectField
      label="List"
      value={value}
      onChange={onChange}
      pending={pending}
      options={options}
      emptyText="That project has no boards or lists"
    />
  );
}

function StatusField({
  projectId,
  value,
  onChange,
}: {
  readonly projectId: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const statuses = useQuery({
    queryKey: projectId === null ? PROJECTS_QUERY_KEY : statusesQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.statuses.list.query({ projectId: projectId ?? '' })),
    enabled: projectId !== null,
  });

  if (projectId === null) return <NeedsProjectHint label="Status" />;

  return (
    <SelectField
      label="Status"
      value={value}
      onChange={onChange}
      pending={statuses.isPending}
      options={(statuses.data ?? []).map((status) => ({
        id: status.statusId,
        name: `${status.name} (${status.category})`,
      }))}
      emptyText="No statuses"
    />
  );
}

function LabelField({
  projectId,
  value,
  onChange,
}: {
  readonly projectId: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const labels = useQuery({
    queryKey: projectId === null ? PROJECTS_QUERY_KEY : labelsQueryKey(projectId),
    queryFn: async () =>
      wire(await apiClient.work.labels.list.query({ projectId: projectId ?? '' })),
    enabled: projectId !== null,
  });

  if (projectId === null) return <NeedsProjectHint label="Label" />;

  return (
    <SelectField
      label="Label"
      value={value}
      onChange={onChange}
      pending={labels.isPending}
      options={(labels.data ?? []).map((entry) => ({ id: entry.labelId, name: entry.name }))}
      emptyText="No labels"
    />
  );
}

function NeedsProjectHint({ label }: { readonly label: string }) {
  return (
    <View style={styles.argumentField}>
      <FieldLabel small>{label}</FieldLabel>
      <Text style={styles.fieldHint}>Choose a project above to pick a {label.toLowerCase()}.</Text>
    </View>
  );
}

/** The one field/modal pair every remote-backed picker renders, so they
 *  cannot drift in behaviour from each other. */
function SelectField({
  label,
  value,
  onChange,
  pending,
  options,
  emptyText,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly pending: boolean;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);

  return (
    <View style={styles.argumentField}>
      <FieldLabel small>{label}</FieldLabel>
      <Pressable
        style={styles.pickerField}
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.pickerFieldValue} numberOfLines={1}>
          {pending ? 'Loading…' : (selected?.name ?? `Choose ${label.toLowerCase()}…`)}
        </Text>
      </Pressable>
      <SelectModal
        open={open}
        title={label}
        pending={pending}
        options={options}
        emptyText={emptyText}
        onSelect={(id) => {
          onChange(id);
          setOpen(false);
        }}
        onClose={() => {
          setOpen(false);
        }}
      />
    </View>
  );
}

function SelectModal({
  open,
  title,
  pending,
  options,
  emptyText,
  onSelect,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly pending: boolean;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly emptyText: string;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={() => undefined}>
          <Text style={styles.modalTitle}>{title}</Text>
          {pending ? (
            <ActivityIndicator color={colors.accent.hex} style={styles.modalLoading} />
          ) : options.length === 0 ? (
            <Text style={styles.modalEmpty}>{emptyText}</Text>
          ) : (
            <ScrollView style={styles.modalList} nestedScrollEnabled>
              {options.map((option) => (
                <Pressable
                  key={option.id}
                  style={styles.modalRow}
                  onPress={() => {
                    onSelect(option.id);
                  }}
                >
                  <Text style={styles.modalRowText} numberOfLines={1}>
                    {option.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <Pressable style={styles.modalCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FieldLabel({
  children,
  small = false,
}: {
  readonly children: React.ReactNode;
  readonly small?: boolean;
}) {
  return <Text style={small ? styles.smallFieldLabel : styles.fieldLabel}>{children}</Text>;
}

const styles = StyleSheet.create({
  editor: {
    flex: 1,
  },
  editorContent: {
    gap: 6,
    paddingBottom: 40,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.inkMuted.hex,
    marginTop: 10,
  },
  smallFieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkFaint.hex,
  },
  fieldHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  textInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceRaised.hex,
  },
  pickerField: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surfaceRaised.hex,
  },
  pickerFieldValue: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  actionsList: {
    gap: 10,
  },
  actionRow: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    padding: 10,
    gap: 6,
    backgroundColor: colors.surfaceSunken.hex + '80',
  },
  actionRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionTypeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
  },
  actionTypeText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  actionTypeChevron: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  removeActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  argumentField: {
    gap: 3,
  },
  priorityChips: {
    flexDirection: 'row',
    gap: 6,
  },
  priorityChip: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  priorityChipActive: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  priorityChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    textTransform: 'capitalize',
  },
  priorityChipTextActive: {
    color: colors.accentInk.hex,
  },
  addActionButton: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    alignItems: 'center',
  },
  addActionButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  errorText: {
    fontSize: 12,
    color: colors.danger.hex,
    marginTop: 8,
  },
  formActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingTop: 14,
  },
  primaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 8,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  modalLoading: {
    marginVertical: 12,
  },
  modalEmpty: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingVertical: 8,
  },
  modalList: {
    maxHeight: 360,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
