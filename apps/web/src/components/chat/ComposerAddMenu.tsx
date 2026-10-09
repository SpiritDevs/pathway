import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectEntry } from "@spiritdevs/contracts";
import {
  ArrowLeftIcon,
  BookmarkIcon,
  BookmarkPlusIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import type { PromptStashEntry } from "../../promptStashStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../ui/command";
import type { ComposerAddSkillItem } from "./composerAddMenu.logic";
import { stashEntryMatchesQuery, stashEntrySnippet } from "./composerPromptStash.logic";

export interface ComposerAddAction {
  id: string;
  label: string;
  description?: string;
  shortcut?: string | null;
  icon: ReactNode;
  disabled?: boolean;
  run: () => void;
}

export const ROW_CLASS =
  "h-8 gap-2.5 rounded-xl px-2.5 py-0 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
export const GROUP_LABEL_CLASS = "px-2.5 pt-2.5 pb-1 text-[13px] font-normal text-muted-foreground";
/** The surface shared by every panel that grows out of the composer's top edge. */
export const ATTACHED_PANEL_CLASS =
  "chat-composer-attached-panel absolute -inset-x-px bottom-[calc(100%+1px)] z-20 max-h-(--add-menu-max-height) overflow-hidden rounded-t-[22px] border border-b-0 border-border/60 shadow-[0_-12px_28px_-20px_rgb(0_0_0/0.35)]";
const PANEL_MAX_HEIGHT_PX = 416;
const PANEL_TOP_GAP_PX = 8;

/**
 * Room above the composer inside the chat pane. The composer overlay is positioned
 * against the pane, so its offset parent is the edge the panel must not cross.
 */
function measureAvailableHeight(panel: HTMLElement): number {
  const composerTop = panel.parentElement?.getBoundingClientRect().top ?? 0;
  const overlay = panel.closest<HTMLElement>("[data-chat-composer-overlay]");
  // The folded floating composer's column hugs it, so measure against the layer it floats in.
  const floating = panel.closest<HTMLElement>('[data-chat-floating="collapsed"]');
  const boundary = floating?.offsetParent ?? overlay?.offsetParent ?? overlay;
  const boundaryTop = boundary ? boundary.getBoundingClientRect().top : 0;
  return Math.min(PANEL_MAX_HEIGHT_PX, composerTop - boundaryTop - PANEL_TOP_GAP_PX);
}

/** Caps an attached panel at the room above the composer, tracking resizes. */
export function useAttachedPanelHeightStyle(
  panelRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => setMaxHeight(Math.max(0, measureAvailableHeight(panel)));
    update();
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined" || !panel.parentElement
        ? null
        : new ResizeObserver(update);
    if (panel.parentElement) observer?.observe(panel.parentElement);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [panelRef]);
  return maxHeight === null
    ? undefined
    : ({ "--add-menu-max-height": `${maxHeight}px` } as CSSProperties);
}

/** The composer's left-hand + button; it only toggles the attached panel. */
export function ComposerAddMenuButton(props: {
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn(
        "shrink-0 rounded-full text-muted-foreground/80",
        props.open && "bg-accent text-foreground",
      )}
      aria-label="Add to message"
      aria-expanded={props.open}
      aria-controls={props.open ? "composer-add-menu" : undefined}
      data-composer-add-trigger="true"
      disabled={props.disabled}
      // Keeps the editor's caret, where the menu's search starts.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onOpenChange(!props.open)}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
}

export type ComposerAddMenuView = "main" | "attachments" | "paths" | "stash";

export type ComposerAddMenuKeyAction =
  | { type: "highlight"; row: string }
  | { type: "pick"; row: string | null }
  | { type: "back" }
  | { type: "close" };

/**
 * What a key typed in the composer does while the add menu is open, or null to
 * leave it to the editor. `rows` are the enabled rows in display order.
 */
export function resolveAddMenuKey(input: {
  key: string;
  shiftKey: boolean;
  view: ComposerAddMenuView;
  rows: readonly string[];
  activeRow: string | null;
}): ComposerAddMenuKeyAction | null {
  const { rows } = input;
  const index = input.activeRow === null ? -1 : rows.indexOf(input.activeRow);
  switch (input.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (rows.length === 0) return null;
      const offset = input.key === "ArrowDown" ? 1 : -1;
      const from = index >= 0 ? index : input.key === "ArrowDown" ? -1 : 0;
      return { type: "highlight", row: rows[(from + offset + rows.length) % rows.length]! };
    }
    case "Enter":
    case "Tab":
      // Shift+Enter still breaks the line, Shift+Tab still switches modes.
      if (input.shiftKey) return null;
      return { type: "pick", row: rows[index] ?? rows[0] ?? null };
    case "Escape":
      return input.view === "main" ? { type: "close" } : { type: "back" };
    default:
      return null;
  }
}

/** Keeps Base UI's own hover highlight out of the way; the composer's keys drive `data-active`. */
const ACTIVE_ROW_CLASS =
  "cursor-pointer select-none hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-active:bg-accent! data-active:text-accent-foreground!";

/**
 * Panel that grows out of the composer's top edge. Render it as a direct child
 * of the composer surface; the surface squares its top corners while it is open.
 * The editor keeps focus: what is typed after the menu opens is `search`, and
 * arrows, Enter, Tab and Escape drive the menu.
 */
export function ComposerAddMenu(props: {
  search: string;
  view: ComposerAddMenuView;
  onViewChange: (view: ComposerAddMenuView) => void;
  attachmentDisabled: boolean;
  actions: readonly ComposerAddAction[];
  skills: readonly ComposerAddSkillItem[];
  skillsLoading: boolean;
  skillsError: string | null;
  onSelectSkill: (item: ComposerAddSkillItem) => void;
  stashEntries: readonly PromptStashEntry[];
  stashShortcut: string | null;
  /** True when the draft is empty or cannot be stashed right now. */
  stashDisabled: boolean;
  stashRestoreDisabled: boolean;
  onStash: () => void;
  onRestoreStash: (entry: PromptStashEntry) => void;
  onDeleteStash: (entry: PromptStashEntry) => void;
  onAttachFiles: () => void;
  paths: readonly Pick<ProjectEntry, "path" | "kind">[];
  pathsLoading: boolean;
  pathsError: string | null;
  canBrowsePaths: boolean;
  onAttachPath: (path: string) => void;
  /** Closes the panel; `restoreFocus` is true when the composer should take focus back. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const { view, search } = props;
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const heightStyle = useAttachedPanelHeightStyle(panelRef);
  const latestRef = useRef({
    view,
    activeRow,
    onClose: props.onClose,
    onViewChange: props.onViewChange,
  });
  latestRef.current = { view, activeRow, onClose: props.onClose, onViewChange: props.onViewChange };

  const enabledRows = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[data-add-menu-row]:not([data-disabled])") ??
        [],
    );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest("[data-composer-add-trigger]")) return;
      latestRef.current.onClose(false);
    };
    // Captured ahead of the editor so Enter picks a row instead of sending.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.isComposing ||
        !(target instanceof Element) ||
        !target.closest('[contenteditable="true"]') ||
        !panelRef.current?.parentElement?.contains(target)
      ) {
        return;
      }
      const rows = enabledRows();
      const action = resolveAddMenuKey({
        key: event.key,
        shiftKey: event.shiftKey,
        view: latestRef.current.view,
        rows: rows.map((row) => row.dataset.addMenuRow ?? ""),
        activeRow: latestRef.current.activeRow,
      });
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === "highlight") setActiveRow(action.row);
      else if (action.type === "pick") {
        rows.find((row) => row.dataset.addMenuRow === action.row)?.click();
      } else if (action.type === "back") latestRef.current.onViewChange("main");
      else latestRef.current.onClose(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // The first enabled row is active until the keys or pointer pick another that is still shown.
  useLayoutEffect(() => {
    const rows = enabledRows();
    const active = rows.find((row) => row.dataset.addMenuRow === activeRow) ?? rows[0];
    const next = active?.dataset.addMenuRow ?? null;
    if (next !== activeRow) setActiveRow(next);
  });
  useLayoutEffect(() => {
    if (activeRow === null) return;
    panelRef.current
      ?.querySelector(`[data-add-menu-row="${CSS.escape(activeRow)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeRow]);

  const rowProps = (value: string, disabled = false) => ({
    value,
    disabled,
    "data-add-menu-row": value,
    "data-active": activeRow === value ? "" : undefined,
    onMouseMove: () => {
      if (!disabled && activeRow !== value) setActiveRow(value);
    },
  });
  const select = (run: () => void) => {
    props.onClose(false);
    run();
  };
  const matches = (label: string, description = "") =>
    `${label} ${description}`.toLowerCase().includes(search.trim().toLowerCase());
  const backButton = (
    <Button
      size="icon-xs"
      variant="ghost"
      className="-ml-1 shrink-0 rounded-full"
      aria-label="Back"
      onClick={() => props.onViewChange("main")}
    >
      <ArrowLeftIcon className="size-4" />
    </Button>
  );
  const subViewLabelClass = cn(GROUP_LABEL_CLASS, "flex items-center gap-1");
  const actionRows = (actions: readonly ComposerAddAction[]) =>
    actions
      .filter((item) => matches(item.label, item.description))
      .map((item) => (
        <CommandItem
          key={item.id}
          {...rowProps(item.id, item.disabled)}
          onClick={() => select(item.run)}
          className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate">
            {item.label}
            {item.description ? (
              <span className="ml-2 text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
          {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
        </CommandItem>
      ));
  const skillRows = props.skills
    .filter((item) => matches(item.label, `${item.skill.name} ${item.description}`))
    .map((item) => (
      <CommandItem
        key={item.id}
        {...rowProps(item.id)}
        onClick={() => select(() => props.onSelectSkill(item))}
        className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
      >
        <SparklesIcon />
        <span className="min-w-0 flex-1 truncate">
          {item.label}
          <span className="ml-2 text-muted-foreground">{item.description}</span>
        </span>
      </CommandItem>
    ));

  const stashRows = props.stashEntries
    .filter((entry) => stashEntryMatchesQuery(entry, search))
    .map((entry) => (
      <CommandItem
        key={entry.id}
        {...rowProps(entry.id, props.stashRestoreDisabled || Boolean(entry.pendingImageCount))}
        onClick={() => select(() => props.onRestoreStash(entry))}
        className={cn(ROW_CLASS, ACTIVE_ROW_CLASS, "group/stash")}
      >
        <BookmarkIcon />
        <span className="min-w-0 flex-1 truncate" title={entry.prompt || stashEntrySnippet(entry)}>
          {stashEntrySnippet(entry)}
        </span>
        {entry.pendingImageCount ? (
          <span className="shrink-0 text-xs text-muted-foreground">Saving attachments…</span>
        ) : entry.droppedImageNames.length + (entry.unreadableImageNames?.length ?? 0) > 0 ? (
          <span className="shrink-0 text-xs text-warning">Attachments missing</span>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTimeLabel(entry.createdAt)}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="-mr-1 shrink-0 rounded-full opacity-0 group-hover/stash:opacity-100 group-data-active/stash:opacity-100 focus-visible:opacity-100"
          aria-label="Delete stashed prompt"
          onClick={(event) => {
            event.stopPropagation();
            // Deleting the last prompt leaves nothing to show here.
            if (props.stashEntries.length === 1) props.onViewChange("main");
            props.onDeleteStash(entry);
          }}
        >
          <XIcon />
        </Button>
      </CommandItem>
    ));
  const stashCurrentRow = matches("Stash current prompt", "save draft later") ? (
    <CommandItem
      {...rowProps("stash-current", props.stashDisabled)}
      className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
      onClick={() => select(props.onStash)}
    >
      <BookmarkPlusIcon />
      <span className="flex-1">Stash current prompt</span>
      {props.stashShortcut ? <CommandShortcut>{props.stashShortcut}</CommandShortcut> : null}
    </CommandItem>
  ) : null;

  return (
    <div
      ref={panelRef}
      id="composer-add-menu"
      role="dialog"
      aria-label="Add to message"
      data-composer-add-menu="true"
      style={heightStyle}
      className={ATTACHED_PANEL_CLASS}
      // The editor owns focus and the keyboard while this menu is open.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Command key={view} autoHighlight={false} mode="none">
        <CommandList className="max-h-(--add-menu-max-height,26rem) overflow-y-auto overscroll-contain px-1.5 pb-1.5">
          {view === "main" ? (
            <>
              <CommandGroup>
                <CommandGroupLabel className={GROUP_LABEL_CLASS}>Add</CommandGroupLabel>
                {matches("Files and folders", "attach upload project") ? (
                  <CommandItem
                    {...rowProps("attachments", props.attachmentDisabled)}
                    className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
                    onClick={() => props.onViewChange("attachments")}
                  >
                    <PaperclipIcon />
                    <span className="flex-1">Files and folders</span>
                    <ChevronRightIcon />
                  </CommandItem>
                ) : null}
                {actionRows(props.actions)}
                {props.stashEntries.length === 0 ? (
                  props.stashDisabled ? null : (
                    stashCurrentRow
                  )
                ) : matches("Stash prompts", "save draft later restore") ? (
                  <CommandItem
                    {...rowProps("stash")}
                    className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
                    onClick={() => props.onViewChange("stash")}
                  >
                    <BookmarkIcon />
                    <span className="flex-1">Stash prompts</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {props.stashEntries.length}
                    </span>
                    <ChevronRightIcon />
                  </CommandItem>
                ) : null}
              </CommandGroup>
              <CommandGroup>
                <CommandGroupLabel className={GROUP_LABEL_CLASS}>Skills</CommandGroupLabel>
                {skillRows}
                {props.skillsLoading ? (
                  <p role="status" className="px-2.5 py-1.5 text-sm text-muted-foreground">
                    Loading skills…
                  </p>
                ) : props.skillsError ? (
                  <p role="status" className="px-2.5 py-1.5 text-sm text-warning">
                    {props.skillsError}
                  </p>
                ) : skillRows.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                    {search.trim()
                      ? "No matching skills."
                      : "No skills available for this provider and project."}
                  </p>
                ) : null}
              </CommandGroup>
            </>
          ) : view === "attachments" ? (
            <CommandGroup>
              <CommandGroupLabel className={subViewLabelClass}>
                {backButton}
                Files and folders
              </CommandGroupLabel>
              <CommandItem
                {...rowProps("upload-files")}
                className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
                onClick={() => select(props.onAttachFiles)}
              >
                <PaperclipIcon />
                <span className="flex-1">
                  Upload files
                  <span className="ml-2 text-muted-foreground">From this device</span>
                </span>
              </CommandItem>
              <CommandItem
                {...rowProps("project-path", !props.canBrowsePaths)}
                className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
                onClick={() => props.onViewChange("paths")}
              >
                <FolderIcon />
                <span className="flex-1">
                  Project file or folder
                  <span className="ml-2 text-muted-foreground">Mention it in the message</span>
                </span>
                <ChevronRightIcon />
              </CommandItem>
            </CommandGroup>
          ) : view === "stash" ? (
            <CommandGroup>
              <CommandGroupLabel className={subViewLabelClass}>
                {backButton}
                Stashed prompts
              </CommandGroupLabel>
              {stashCurrentRow}
              {stashRows}
              {stashRows.length === 0 ? (
                <p role="status" className="px-2.5 py-1.5 text-sm text-muted-foreground">
                  No matching stashed prompts.
                </p>
              ) : null}
            </CommandGroup>
          ) : (
            <CommandGroup>
              <CommandGroupLabel className={subViewLabelClass}>
                {backButton}
                Project files and folders
              </CommandGroupLabel>
              {props.paths.map((entry) => (
                <CommandItem
                  key={`${entry.kind}:${entry.path}`}
                  {...rowProps(entry.path)}
                  className={cn(ROW_CLASS, ACTIVE_ROW_CLASS)}
                  onClick={() => select(() => props.onAttachPath(entry.path))}
                >
                  {entry.kind === "directory" ? <FolderIcon /> : <FileIcon />}
                  <span className="truncate">{entry.path}</span>
                </CommandItem>
              ))}
              {props.pathsLoading || props.pathsError || props.paths.length === 0 ? (
                <p role="status" className="px-2.5 py-1.5 text-sm text-muted-foreground">
                  {props.pathsLoading
                    ? "Searching project files and folders…"
                    : (props.pathsError ??
                      (search.trim()
                        ? "No matching files or folders."
                        : "Type to search project files and folders."))}
                </p>
              ) : null}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
