import {
  ALL_FOCUS_ID,
  focusOrderKeyAfter,
  sortFocuses,
} from "@spiritdevs/client-runtime/state/focuses";
import {
  FOCUS_NAME_MAX_CHARS,
  FocusId,
  FocusProjectKey,
  type Focus,
  type FocusAssignment,
} from "@spiritdevs/contracts/focus";
import { Layers3Icon, LoaderCircleIcon, PencilIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import type { FocusMutations } from "../../cloud/focusReadModel";
import { cn, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FOCUS_ICON_OPTIONS, FocusIcon } from "./FocusIcon";
import { projectFocusSelection, type FocusProjectOption } from "./FocusStrip.logic";
import {
  FOCUS_THREAD_SORT_LABELS,
  FOCUS_THREAD_SORT_ORDERS,
  useFocusViews,
  type FocusViewChoices,
} from "./focusViewPreferences";

export type { FocusProjectOption } from "./FocusStrip.logic";

export const FOCUS_ACCENT_COLORS = [
  "#3b82f6",
  "#06b6d4",
  "#14b8a6",
  "#22c55e",
  "#84cc16",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
] as const;

/** Projects get a search header once the list outgrows a glance. */
const PROJECT_SEARCH_THRESHOLD = 4;

const SORT_ITEMS = FOCUS_THREAD_SORT_ORDERS.map((value) => ({
  value,
  label: FOCUS_THREAD_SORT_LABELS[value],
}));

const sameView = (left: FocusViewChoices, right: FocusViewChoices) =>
  left.sortOrder === right.sortOrder && left.collapsiblePinned === right.collapsiblePinned;

function FocusViewFields(props: {
  readonly value: FocusViewChoices;
  readonly disabled: boolean;
  readonly onChange: (value: FocusViewChoices) => void;
}) {
  return (
    <div className="grid gap-2 text-xs text-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Sort threads</span>
        <Select
          value={props.value.sortOrder}
          items={SORT_ITEMS}
          disabled={props.disabled}
          onValueChange={(sortOrder) => {
            if (sortOrder) props.onChange({ ...props.value, sortOrder });
          }}
        >
          <SelectTrigger size="xs" aria-label="Sort threads" className="h-7 w-44 text-xs sm:h-7">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {SORT_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value} className="min-h-7 py-1 text-xs">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="font-medium">Collapsible pinned chats</span>
        <Switch
          checked={props.value.collapsiblePinned}
          disabled={props.disabled}
          onCheckedChange={(collapsiblePinned) =>
            props.onChange({ ...props.value, collapsiblePinned })
          }
        />
      </label>
    </div>
  );
}

function FocusEditorFooter(props: {
  readonly saving: boolean;
  readonly canSave: boolean;
  readonly saveLabel: string;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {props.children}
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={props.saving}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={props.saving || !props.canSave}>
          {props.saving ? (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          ) : null}
          {props.saveLabel}
        </Button>
      </div>
    </div>
  );
}

/** All has no name, icon, or projects to edit; only how its sidebar is laid out. */
export function AllFocusViewEditor(props: { readonly onClose: () => void }) {
  const { viewFor, saveFocusView, canSave } = useFocusViews();
  const [view, setView] = useState<FocusViewChoices>(() => viewFor(ALL_FOCUS_ID));
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  return (
    <form
      className="flex w-[22rem] max-w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setErrorMessage(null);
        void saveFocusView(ALL_FOCUS_ID, view)
          .then(props.onClose)
          .catch((error: unknown) => {
            setErrorMessage(error instanceof Error ? error.message : "Could not save.");
            setSaving(false);
          });
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]">
          <Layers3Icon className="size-4" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">All</h2>
      </div>
      <FocusViewFields value={view} disabled={saving} onChange={setView} />
      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {errorMessage}
        </p>
      ) : null}
      <FocusEditorFooter
        saving={saving}
        canSave={canSave}
        saveLabel="Save"
        onCancel={props.onClose}
      />
    </form>
  );
}

export function FocusEditor(props: {
  readonly focus: Focus | null;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<FocusAssignment>;
  readonly projects: ReadonlyArray<FocusProjectOption>;
  readonly mutations: FocusMutations | null;
  readonly onClose: () => void;
}) {
  const { focus } = props;
  const [name, setName] = useState(focus?.name ?? "");
  const [iconName, setIconName] = useState(focus?.iconName ?? "Briefcase");
  const [accentColor, setAccentColor] = useState(focus?.accentColor ?? FOCUS_ACCENT_COLORS[0]);
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<ReadonlySet<FocusProjectKey>>(
    () =>
      new Set(
        focus === null
          ? []
          : props.assignments
              .filter((assignment) => assignment.focusId === focus.id)
              .map((assignment) => assignment.projectKey),
      ),
  );

  // Appearance folds away while editing so the dialog opens at its shortest.
  const [appearanceOpen, setAppearanceOpen] = useState(focus === null);
  const [projectQuery, setProjectQuery] = useState("");
  const { viewFor, saveFocusView } = useFocusViews();
  const [initialView] = useState<FocusViewChoices>(() => viewFor(focus?.id ?? ""));
  const [view, setView] = useState(initialView);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const focusById = useMemo(
    () => new Map(props.focuses.map((item) => [item.id, item] as const)),
    [props.focuses],
  );
  const assignmentByProject = useMemo(
    () =>
      new Map(
        props.assignments.map((assignment) => [assignment.projectKey, assignment.focusId] as const),
      ),
    [props.assignments],
  );

  const toggleProject = (projectKeys: ReadonlyArray<FocusProjectKey>, checked: boolean) => {
    setSelectedProjectKeys((current) => {
      const next = new Set(current);
      for (const projectKey of projectKeys) {
        if (checked) next.add(projectKey);
        else next.delete(projectKey);
      }
      return next;
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || props.mutations === null || saving) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      if (focus === null) {
        const focusId = FocusId.make(randomUUID());
        const ordered = sortFocuses(props.focuses);
        await props.mutations.create({
          id: focusId,
          name: trimmedName,
          iconName,
          accentColor,
          includeConversations: false,
          orderKey: focusOrderKeyAfter(ordered.at(-1)?.orderKey ?? null),
          projectKeys: [...selectedProjectKeys],
        });
        if (!sameView(view, initialView)) await saveFocusView(focusId, view);
      } else {
        if (!sameView(view, initialView)) await saveFocusView(focus.id, view);
        await props.mutations.update({
          focusId: focus.id,
          name: trimmedName,
          iconName,
          accentColor,
          includeConversations: false,
        });
        const currentlyAssigned = new Set(
          props.assignments
            .filter((assignment) => assignment.focusId === focus.id)
            .map((assignment) => assignment.projectKey),
        );
        await Promise.all([
          ...[...selectedProjectKeys]
            .filter((projectKey) => assignmentByProject.get(projectKey) !== focus.id)
            .map((projectKey) => props.mutations!.assignProject({ focusId: focus.id, projectKey })),
          ...[...currentlyAssigned]
            .filter(
              (projectKey) =>
                !selectedProjectKeys.has(projectKey) &&
                assignmentByProject.get(projectKey) === focus.id,
            )
            .map((projectKey) => props.mutations!.unassignProject({ projectKey })),
        ]);
      }
      props.onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not save this Focus.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (focus === null || props.mutations === null || saving) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      await props.mutations.remove({ focusId: focus.id });
      props.onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not delete this Focus.");
      setSaving(false);
    }
  };

  const normalizedProjectQuery = projectQuery.trim().toLowerCase();
  const shownProjects =
    normalizedProjectQuery.length === 0
      ? props.projects
      : props.projects.filter((project) =>
          project.name.toLowerCase().includes(normalizedProjectQuery),
        );

  return (
    <form onSubmit={submit} className="flex w-[22rem] max-w-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]"
          style={{ color: accentColor }}
        >
          <FocusIcon iconName={iconName} className="size-4" />
        </span>
        <div className="relative min-w-0 flex-1">
          <Input
            autoFocus
            aria-label="Focus name"
            maxLength={FOCUS_NAME_MAX_CHARS}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={focus === null ? "New Focus" : "Focus name"}
            disabled={saving}
            className="pe-8"
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={appearanceOpen ? "Hide icon and color" : "Edit icon and color"}
            title={appearanceOpen ? "Hide icon and color" : "Edit icon and color"}
            aria-expanded={appearanceOpen}
            aria-controls="focus-appearance"
            onClick={() => setAppearanceOpen((open) => !open)}
            className={cn(
              "absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground",
              appearanceOpen && "bg-accent text-foreground",
            )}
          >
            <PencilIcon />
          </Button>
        </div>
      </div>

      {/* Grid rows animate the fold without measuring content height. */}
      <div
        id="focus-appearance"
        inert={!appearanceOpen}
        className={cn(
          "-mt-3 grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
          appearanceOpen ? "mt-0 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="grid min-h-0 gap-3 overflow-hidden">
          <fieldset className="grid gap-2">
            <legend className="text-xs font-medium text-foreground">Icon</legend>
            <div className="grid grid-cols-10 gap-1" role="radiogroup" aria-label="Focus icon">
              {FOCUS_ICON_OPTIONS.map((option) => (
                <button
                  key={option.name}
                  type="button"
                  role="radio"
                  aria-checked={iconName === option.name}
                  aria-label={option.label}
                  title={option.label}
                  disabled={saving}
                  onClick={() => setIconName(option.name)}
                  className="flex aspect-square cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-foreground/[0.09] aria-checked:text-foreground disabled:pointer-events-none disabled:opacity-60"
                >
                  <option.icon className="size-3.5" />
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="text-xs font-medium text-foreground">Color</legend>
            <div
              className="flex items-center justify-between"
              role="radiogroup"
              aria-label="Focus color"
            >
              {FOCUS_ACCENT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={accentColor.toLowerCase() === color}
                  aria-label={color}
                  disabled={saving}
                  onClick={() => setAccentColor(color)}
                  className="relative flex size-6 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60"
                >
                  <span
                    className="size-4 rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-popover transition-transform aria-hidden:scale-110"
                    style={{ backgroundColor: color }}
                  />
                  {accentColor.toLowerCase() === color ? (
                    <span
                      className="pointer-events-none absolute size-5 rounded-full ring-2 ring-current"
                      style={{ color }}
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>

      <fieldset className="grid min-h-0 gap-2">
        <legend className="text-xs font-medium text-foreground">Projects</legend>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border/70 p-1 pt-0">
          {props.projects.length > PROJECT_SEARCH_THRESHOLD ? (
            <label className="sticky top-0 z-10 -mx-1 mb-1 flex items-center gap-2 border-b border-border/70 bg-popover px-3 py-1.5">
              <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                type="search"
                aria-label="Search projects"
                placeholder="Search projects"
                value={projectQuery}
                onChange={(event) => setProjectQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  // Enter filters; it must not submit the Focus.
                  if (event.key === "Enter") event.preventDefault();
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          ) : (
            <div className="h-1" />
          )}
          {props.projects.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No projects are visible in this company.
            </p>
          ) : shownProjects.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No matching projects.
            </p>
          ) : (
            shownProjects.map((project) => {
              const selectedCount = project.projectKeys.filter((projectKey) =>
                selectedProjectKeys.has(projectKey),
              ).length;
              const checked = selectedCount === project.projectKeys.length;
              const indeterminate = selectedCount > 0 && !checked;
              const assignment = projectFocusSelection(project.projectKeys, props.assignments);
              const movingFromFocusIds = new Set(
                project.projectKeys.flatMap((projectKey) => {
                  if (!selectedProjectKeys.has(projectKey)) return [];
                  const assignedFocusId = assignmentByProject.get(projectKey);
                  return assignedFocusId !== undefined && assignedFocusId !== focus?.id
                    ? [assignedFocusId]
                    : [];
                }),
              );
              const movingFromFocuses = [...movingFromFocusIds]
                .map((focusId) => focusById.get(focusId))
                .filter((assignedFocus): assignedFocus is Focus => assignedFocus !== undefined);
              const assignmentLabel =
                assignment === "none"
                  ? "No Focus"
                  : assignment === "mixed"
                    ? "Mixed Focuses"
                    : (focusById.get(assignment)?.name ?? "No Focus");
              const statusLabel =
                movingFromFocuses.length === 1
                  ? `Moving from ${movingFromFocuses[0]!.name}`
                  : movingFromFocuses.length > 1
                    ? "Moving from multiple Focuses"
                    : assignmentLabel;
              return (
                <label
                  key={project.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/70"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    indeterminate={indeterminate}
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      toggleProject(project.projectKeys, checked === true)
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="truncate">{project.name}</span>
                    </span>
                    <span className="block text-[10px] text-muted-foreground">{statusLabel}</span>
                  </span>
                </label>
              );
            })
          )}
        </div>
      </fieldset>

      <FocusViewFields value={view} disabled={saving} onChange={setView} />

      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {errorMessage}
        </p>
      ) : null}

      <FocusEditorFooter
        saving={saving}
        canSave={props.mutations !== null && name.trim().length > 0}
        saveLabel={focus === null ? "Create" : "Save"}
        onCancel={props.onClose}
      >
        {focus !== null ? (
          confirmingDelete ? (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={saving}
                onClick={() => void remove()}
              >
                Delete Focus
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={saving}
              onClick={() => setConfirmingDelete(true)}
              className="text-destructive-foreground"
            >
              <Trash2Icon />
              Delete
            </Button>
          )
        ) : null}
      </FocusEditorFooter>
    </form>
  );
}
