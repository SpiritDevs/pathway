import {
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@spiritdevs/contracts";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_POPUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<OpenInOption> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      label: "Kiro",
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      label: "VSCodium",
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      label: "IntelliJ IDEA",
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      label: "Aqua",
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      label: "CLion",
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      label: "DataGrip",
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      label: "DataSpell",
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      label: "GoLand",
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      label: "PhpStorm",
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      label: "PyCharm",
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      label: "Rider",
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      label: "RubyMine",
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      label: "RustRover",
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      label: "WebStorm",
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
      kind: "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions.filter((option) => availableEditorSet.has(option.value));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  compact = false,
  variant = "toolbar",
  displayMode = "toolbar",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  compact?: boolean;
  variant?: "toolbar" | "card";
  displayMode?: "toolbar" | "panel";
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const [editorOptionsOpen, setEditorOptionsOpen] = useState(false);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const secondaryOptions = options.filter(({ value }) => value !== preferredEditor);

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      if (!openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      const result = openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor,
        },
      });
      setPreferredEditor(editor);
      setEditorOptionsOpen(false);
      return result;
    },
    [environmentId, openInCwd, openInEditorMutation, preferredEditor, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );
  const primaryLabel = isPanel ? `Open in ${primaryOption?.label ?? "editor"}` : "Open";

  if (variant === "card") {
    if (!primaryOption) {
      return (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">No installed editors found</p>
      );
    }

    const PrimaryIcon = primaryOption.Icon;

    return (
      <Collapsible open={editorOptionsOpen} onOpenChange={setEditorOptionsOpen}>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={!openInCwd}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => openInEditor(primaryOption.value)}
          >
            <PrimaryIcon
              aria-hidden="true"
              className={cn("size-4 shrink-0", getOpenInIconClass(primaryOption.kind))}
            />
            <span className="truncate">Open in {primaryOption.label}</span>
            {openFavoriteEditorShortcutLabel ? (
              <span className="ml-auto text-[11px] text-muted-foreground">
                {openFavoriteEditorShortcutLabel}
              </span>
            ) : null}
          </button>
          {secondaryOptions.length > 0 ? (
            <button
              type="button"
              data-keep-action-card-open
              aria-label={editorOptionsOpen ? "Hide other editors" : "Show other editors"}
              aria-expanded={editorOptionsOpen}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setEditorOptionsOpen((open) => !open)}
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "size-4 transition-transform duration-200 motion-reduce:transition-none",
                  editorOptionsOpen && "rotate-180",
                )}
              />
            </button>
          ) : null}
        </div>
        <CollapsiblePanel>
          <div className="space-y-0.5 pt-0.5">
            {secondaryOptions.map(({ label, Icon, value, kind }) => (
              <button
                key={value}
                type="button"
                disabled={!openInCwd}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => openInEditor(value)}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", getOpenInIconClass(kind))}
                />
                <span className="truncate">Open in {label}</span>
              </button>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    );
  }

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <Button
        aria-label={compact ? "Open file in preferred editor" : primaryLabel}
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        className={isPanel ? THREAD_DETAILS_PANEL_SPLIT_PRIMARY_CLASS : undefined}
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn(
              isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
              getOpenInIconClass(primaryOption.kind),
            )}
          />
        )}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && "not-sr-only ml-0.5 min-w-0 truncate",
          )}
        >
          {primaryLabel}
        </span>
      </Button>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Choose editor"
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              className={isPanel ? THREAD_DETAILS_PANEL_SPLIT_SECONDARY_CLASS : undefined}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? THREAD_DETAILS_PANEL_ROW_POPUP_CLASS : undefined}
        >
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
