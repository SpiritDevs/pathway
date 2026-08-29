import { focusOrderKeyAfter, sortFocuses } from "@spiritdevs/client-runtime/state/focuses";
import {
  FOCUS_NAME_MAX_CHARS,
  FocusId,
  FocusProjectKey,
  type Focus,
  type FocusAssignment,
} from "@spiritdevs/contracts/focus";
import { LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import type { FocusMutations } from "../../cloud/focusReadModel";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { FOCUS_ICON_OPTIONS, FocusIcon } from "./FocusIcon";
import { projectFocusSelection, type FocusProjectOption } from "./FocusStrip.logic";

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
          orderKey: focusOrderKeyAfter(ordered.at(-1)?.orderKey ?? null),
          projectKeys: [...selectedProjectKeys],
        });
      } else {
        await props.mutations.update({
          focusId: focus.id,
          name: trimmedName,
          iconName,
          accentColor,
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

  return (
    <form onSubmit={submit} className="flex w-[22rem] max-w-full flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05]"
          style={{ color: accentColor }}
        >
          <FocusIcon iconName={iconName} className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {focus === null ? "Create Focus" : "Edit Focus"}
          </h2>
          <p className="text-xs text-muted-foreground">Choose the projects that belong here.</p>
        </div>
      </div>

      <label className="grid gap-1.5 text-xs font-medium text-foreground">
        Name
        <Input
          autoFocus
          maxLength={FOCUS_NAME_MAX_CHARS}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Work"
          disabled={saving}
        />
      </label>

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

      <fieldset className="grid min-h-0 gap-2">
        <legend className="text-xs font-medium text-foreground">Projects</legend>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border/70 p-1">
          {props.projects.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No projects are visible in this company.
            </p>
          ) : (
            props.projects.map((project) => {
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

      {errorMessage ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
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
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" size="xs" variant="ghost" disabled={saving} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="xs"
            disabled={saving || props.mutations === null || name.trim().length === 0}
          >
            {saving ? (
              <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {focus === null ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}
