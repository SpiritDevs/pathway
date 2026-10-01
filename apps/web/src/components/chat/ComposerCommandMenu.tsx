import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@spiritdevs/contracts";
import {
  BotIcon,
  CpuIcon,
  MonitorIcon,
  PencilRulerIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { formatProviderSkillInstallSource } from "~/providerSkillPresentation";
import { cn } from "~/lib/utils";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import {
  ATTACHED_PANEL_CLASS,
  GROUP_LABEL_CLASS,
  ROW_CLASS,
  useAttachedPanelHeightStyle,
} from "./ComposerAddMenu";
import { PierreEntryIcon } from "./PierreEntryIcon";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    };

type ComposerCommandGroup = {
  id: ComposerCommandItem["type"];
  label: string;
  items: ComposerCommandItem[];
};

const GROUP_LABELS: Record<ComposerCommandItem["type"], string> = {
  "slash-command": "Tools",
  "provider-slash-command": "Commands",
  skill: "Skills",
  path: "Files and folders",
};

const TOOL_ICONS: Record<ComposerSlashCommand, typeof BotIcon> = {
  goal: TargetIcon,
  plan: PencilRulerIcon,
  default: BotIcon,
  "computer-use": MonitorIcon,
  model: CpuIcon,
};

function SkillGlyph(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

/** Splits the ranked list into labelled runs, keeping the caller's order. */
function groupCommandItems(items: ComposerCommandItem[]): ComposerCommandGroup[] {
  const groups: ComposerCommandGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.id === item.type) last.items.push(item);
    else groups.push({ id: item.type, label: GROUP_LABELS[item.type], items: [item] });
  }
  return groups;
}

/**
 * The `/`, `$`, and `@` menu. It grows out of the composer's top edge like the +
 * menu, while the editor keeps focus: typing filters it, arrows move, Enter selects.
 */
export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const heightStyle = useAttachedPanelHeightStyle(panelRef);
  const groups = useMemo(() => groupCommandItems(props.items), [props.items]);

  useLayoutEffect(() => {
    if (!props.activeItemId || !panelRef.current) return;
    const el = panelRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={props.triggerKind === "skill" ? "Skills" : "Tools and skills"}
      data-composer-command-menu="true"
      style={heightStyle}
      className={ATTACHED_PANEL_CLASS}
      // The editor owns focus and the keyboard while this menu is open.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Command
        autoHighlight={false}
        mode="none"
        onItemHighlighted={(highlightedValue) => {
          props.onHighlightedItemChange(
            typeof highlightedValue === "string" ? highlightedValue : null,
          );
        }}
      >
        {props.items.length > 0 ? (
          <CommandList className="max-h-(--add-menu-max-height,26rem) overflow-y-auto overscroll-contain px-1.5 pb-1.5">
            {groups.map((group) => (
              <CommandGroup key={group.id}>
                <CommandGroupLabel className={GROUP_LABEL_CLASS}>{group.label}</CommandGroupLabel>
                {group.items.map((item) => (
                  <ComposerCommandMenuItem
                    key={item.id}
                    item={item}
                    resolvedTheme={props.resolvedTheme}
                    isActive={props.activeItemId === item.id}
                    onHighlight={props.onHighlightedItemChange}
                    onSelect={props.onSelect}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        ) : (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            {props.isLoading
              ? props.triggerKind === "path"
                ? "Searching project files and folders…"
                : "Loading skills…"
              : (props.emptyStateText ?? "No matches.")}
          </p>
        )}
      </Command>
    </div>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const { item } = props;
  const skillSourceLabel =
    item.type === "skill" ? formatProviderSkillInstallSource(item.skill) : null;
  const ToolIcon = item.type === "slash-command" ? TOOL_ICONS[item.command] : null;

  return (
    <CommandItem
      value={item.id}
      data-composer-item-id={item.id}
      className={cn(
        ROW_CLASS,
        "cursor-pointer select-none hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(item.id);
      }}
      onClick={() => {
        props.onSelect(item);
      }}
    >
      {item.type === "path" ? (
        <PierreEntryIcon pathValue={item.path} kind={item.pathKind} theme={props.resolvedTheme} />
      ) : ToolIcon ? (
        <ToolIcon />
      ) : item.type === "skill" ? (
        <SparklesIcon />
      ) : (
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <SkillGlyph className="size-3.5" />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {item.label}
        {item.description ? (
          <span className="ml-2 text-muted-foreground">{item.description}</span>
        ) : null}
      </span>
      {skillSourceLabel ? (
        <span className="shrink-0 pl-2 text-xs text-muted-foreground">{skillSourceLabel}</span>
      ) : null}
    </CommandItem>
  );
});
