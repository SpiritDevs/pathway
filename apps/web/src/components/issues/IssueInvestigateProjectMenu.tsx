/**
 * Project choice shared by the issue sheet and the issue-list bulk bar.
 *
 * Choosing is the action: callers assign the issue first when needed, then start the read-only
 * investigation. Only projects with a workspace are passed here, so every visible choice can run.
 */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { ProjectId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function IssueInvestigateProjectMenu({
  projects,
  currentProjectId,
  disabledReason,
  children,
  onSelect,
  align = "end",
  side = "bottom",
}: {
  projects: ReadonlyArray<EnvironmentProject>;
  currentProjectId: ProjectId | null;
  disabledReason: string | null;
  children: ReactNode;
  onSelect: (projectId: ProjectId) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
}) {
  const trigger = (
    <Button disabled={disabledReason !== null} size="xs" variant="outline">
      {children}
      <ChevronDownIcon className="size-3 opacity-70" />
    </Button>
  );

  if (disabledReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
          {trigger}
        </TooltipTrigger>
        <TooltipPopup>{disabledReason}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <MenuTrigger render={trigger} />
      <MenuPopup align={align} className="min-w-64" side={side}>
        <MenuGroup>
          <MenuGroupLabel>Investigate in project</MenuGroupLabel>
          {projects.map((project) => (
            <MenuItem closeOnClick key={project.id} onClick={() => onSelect(project.id)}>
              <FolderIcon />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.title}</span>
                <span className="block max-w-64 truncate text-[11px] text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </span>
              <CheckIcon
                aria-hidden
                className={cn("size-3.5", currentProjectId !== project.id && "invisible")}
              />
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
