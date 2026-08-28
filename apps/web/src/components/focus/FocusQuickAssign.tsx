import { sortFocuses } from "@spiritdevs/client-runtime/state/focuses";
import { FocusProjectKey, type Focus, type FocusAssignment } from "@spiritdevs/contracts/focus";
import { CheckIcon } from "lucide-react";

import type { FocusMutations } from "../../cloud/focusReadModel";
import { toastManager } from "../ui/toast";
import { MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { FocusIcon } from "./FocusIcon";
import { projectFocusSelection } from "./FocusStrip.logic";

export function FocusQuickAssignItems(props: {
  readonly projectKeys: ReadonlyArray<string>;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<FocusAssignment>;
  readonly mutations: FocusMutations | null;
}) {
  const selection = projectFocusSelection(props.projectKeys, props.assignments);
  const assign = (focusId: string) => {
    if (props.mutations === null) return;
    const projectKeys = props.projectKeys.map((projectKey) => FocusProjectKey.make(projectKey));
    const focus = props.focuses.find((item) => item.id === focusId);
    if (focusId !== "none" && focus === undefined) return;
    const operation =
      focusId === "none"
        ? Promise.all(
            projectKeys.map((projectKey) => props.mutations!.unassignProject({ projectKey })),
          )
        : Promise.all(
            projectKeys.map((projectKey) =>
              props.mutations!.assignProject({
                focusId: focus!.id,
                projectKey,
              }),
            ),
          );
    void operation.catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not update Focus",
        description: error instanceof Error ? error.message : "The project assignment failed.",
      });
    });
  };

  return (
    <>
      <MenuGroupLabel>Focus</MenuGroupLabel>
      <MenuRadioGroup value={selection} onValueChange={assign}>
        <MenuRadioItem value="none" closeOnClick disabled={props.mutations === null}>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-muted-foreground/35" />
            <span className="flex-1">None</span>
            {selection === "none" ? <CheckIcon className="ml-auto size-3.5" /> : null}
          </span>
        </MenuRadioItem>
        {sortFocuses(props.focuses).map((focus) => (
          <MenuRadioItem
            key={focus.id}
            value={focus.id}
            closeOnClick
            disabled={props.mutations === null}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FocusIcon
                iconName={focus.iconName}
                color={focus.accentColor}
                className="size-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{focus.name}</span>
              {selection === focus.id ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
