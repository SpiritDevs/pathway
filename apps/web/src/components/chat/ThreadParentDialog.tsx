import { useAtomValue } from "@effect/atom-react";
import type { ProjectId } from "@spiritdevs/contracts";
import { CornerDownRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { onOpenThreadParentPicker, type ThreadParentPickerTarget } from "../../threadParentBus";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../CommandPalette.logic";
import { CommandPaletteContent } from "../CommandPaletteContent";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { threadParentCandidates } from "./ThreadParentDialog.logic";

const RECENT_PARENT_LIMIT = 50;

/** The "Set parent" picker, opened from any surface with `openThreadParentPicker`. */
export function ThreadParentDialog() {
  const [target, setTarget] = useState<ThreadParentPickerTarget | null>(null);
  useEffect(() => onOpenThreadParentPicker(setTarget), []);
  return (
    <CommandDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      {target === null ? null : (
        <ThreadParentPicker target={target} onClose={() => setTarget(null)} />
      )}
    </CommandDialog>
  );
}

function ThreadParentPicker(props: {
  readonly target: ThreadParentPickerTarget;
  readonly onClose: () => void;
}) {
  const { target, onClose } = props;
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const setParent = useAtomCommand(threadEnvironment.setParent);

  const items = useMemo<CommandPaletteActionItem[]>(() => {
    const projectTitles = new Map<string, string>(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const environmentLabels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label]),
    );
    const projectTitle = (environmentId: string, projectId: ProjectId | null) =>
      projectId === null ? "Conversation" : projectTitles.get(`${environmentId}:${projectId}`);
    return threadParentCandidates(threads, target)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => {
        const environmentLabel =
          thread.environmentId === target.environmentId
            ? undefined
            : environmentLabels.get(thread.environmentId);
        const project = projectTitle(thread.environmentId, thread.projectId);
        return {
          kind: "action",
          value: `thread-parent:${thread.environmentId}:${thread.id}`,
          searchTerms: [thread.title, project ?? "", environmentLabel ?? ""],
          title: thread.title,
          description: [project, environmentLabel].filter(Boolean).join(" · "),
          timestamp: formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt),
          icon: <CornerDownRightIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await setParent({
              environmentId: target.environmentId,
              input: {
                threadId: target.threadId,
                parent: {
                  threadId: thread.id,
                  ...(thread.environmentId === target.environmentId
                    ? {}
                    : { environmentId: thread.environmentId }),
                },
              },
            });
          },
        };
      });
  }, [environments, projects, setParent, target, threads]);

  const groups = useMemo<CommandPaletteGroup[]>(
    () =>
      query.trim().length === 0
        ? [
            {
              value: "threads",
              label: "Recent threads",
              items: items.slice(0, RECENT_PARENT_LIMIT),
            },
          ]
        : filterCommandPaletteGroups({
            activeGroups: [],
            query,
            isInSubmenu: false,
            projectSearchItems: [],
            threadSearchItems: items,
          }),
    [items, query],
  );

  return (
    <CommandDialogPopup
      aria-label="Set parent thread"
      className="overflow-hidden p-0"
      onBackdropPointerDown={onClose}
    >
      <CommandPaletteContent
        aria-label="Set parent thread"
        autoHighlight="always"
        escapeLabel="Close"
        footerActionLabel="List under this thread"
        inputProps={{ placeholder: "Search threads to list this one under…" }}
        mode="none"
        onItemHighlighted={(value) => {
          setHighlightedItemValue(typeof value === "string" ? value : null);
        }}
        onValueChange={(value) => {
          setHighlightedItemValue(null);
          setQuery(value);
        }}
        panelClassName="max-h-[min(34rem,76vh)]"
        testId="thread-parent-picker"
        value={query}
      >
        <CommandPaletteResults
          groups={groups}
          highlightedItemValue={highlightedItemValue}
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={(item) => {
            if (item.kind !== "action") return;
            onClose();
            void item.run();
          }}
          emptyStateMessage={query.trim() ? "No matching threads." : "No other threads."}
        />
      </CommandPaletteContent>
    </CommandDialogPopup>
  );
}
