import type { ProjectIcon } from "@spiritdevs/contracts/cloudProject";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { cloudProjectsAtom } from "~/cloud/issueDomainReadModel";
import { IconColorPicker, LIBRARY_ICON_COLORS } from "../focus/IconColorPicker";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

/** The company project's synced library icon, or null when it uses detected favicons. */
export function useCompanyProjectIcon(cloudProjectId: string | null): ProjectIcon | null {
  const cloudProjects = useAtomValue(cloudProjectsAtom) ?? [];
  return cloudProjectId === null
    ? null
    : (cloudProjects.find((project) => project.id === cloudProjectId)?.icon ?? null);
}

/** Chooses a library icon for every checkout of a company project; applies on each pick. */
export function ProjectLibraryIconPicker(props: {
  readonly companyId: CompanyId;
  readonly cloudProjectId: string;
  readonly icon: ProjectIcon | null;
}) {
  const environmentControl = useEnvironmentControl();
  const [saving, setSaving] = useState(false);
  const shown = props.icon ?? { name: "Code2", color: LIBRARY_ICON_COLORS[0] };
  const save = (icon: ProjectIcon | null) => {
    if (environmentControl === null) return;
    setSaving(true);
    void environmentControl
      .setCompanyProjectIcon({
        companyId: props.companyId,
        cloudProjectId: props.cloudProjectId,
        icon,
      })
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not save the project icon",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      )
      .finally(() => setSaving(false));
  };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={saving || environmentControl === null}
          />
        }
      >
        Choose icon
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <IconColorPicker
          subject="Project"
          iconName={shown.name}
          color={shown.color}
          disabled={saving}
          onIconChange={(name) => save({ ...shown, name })}
          onColorChange={(color) => save({ ...shown, color })}
        />
        <Button
          className="mt-3"
          size="xs"
          variant="outline"
          disabled={saving || props.icon === null}
          onClick={() => save(null)}
        >
          Use detected icon
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
