import type { CSSProperties, ReactNode } from "react";
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
  CommandInput,
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

const ROW_CLASS =
  "h-8 gap-2.5 rounded-xl px-2.5 py-0 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";
const GROUP_LABEL_CLASS = "px-2.5 pt-2.5 pb-1 text-[13px] font-normal text-muted-foreground";
const PANEL_MAX_HEIGHT_PX = 416;
const PANEL_TOP_GAP_PX = 8;

/**
 * Room above the composer inside the chat pane. The composer overlay is positioned
 * against the pane, so its offset parent is the edge the panel must not cross.
 */
function measureAvailableHeight(panel: HTMLElement): number {
  const composerTop = panel.parentElement?.getBoundingClientRect().top ?? 0;
  const overlay = panel.closest<HTMLElement>("[data-chat-composer-overlay]");
  const boundary = overlay?.offsetParent ?? overlay;
  const boundaryTop = boundary ? boundary.getBoundingClientRect().top : 0;
  return Math.min(PANEL_MAX_HEIGHT_PX, composerTop - boundaryTop - PANEL_TOP_GAP_PX);
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
      onClick={() => props.onOpenChange(!props.open)}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
}

/**
 * Panel that grows out of the composer's top edge. Render it as a direct child
 * of the composer surface; the surface squares its top corners while it is open.
 */
export function ComposerAddMenu(props: {
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
  onPathQueryChange: (query: string | null) => void;
  onAttachPath: (path: string) => void;
  /** Closes the panel; `restoreFocus` is true when the composer should take focus back. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [view, setView] = useState<"main" | "attachments" | "paths" | "stash">("main");
  const [query, setQuery] = useState("");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

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
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest("[data-composer-add-trigger]")) return;
      onCloseRef.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const changeView = (next: typeof view) => {
    setView(next);
    setQuery("");
    props.onPathQueryChange(next === "paths" ? "" : null);
  };
  const select = (run: () => void) => {
    props.onPathQueryChange(null);
    props.onClose(false);
    run();
  };
  const matches = (label: string, description = "") =>
    `${label} ${description}`.toLowerCase().includes(query.trim().toLowerCase());
  const actionRows = (actions: readonly ComposerAddAction[]) =>
    actions
      .filter((item) => matches(item.label, item.description))
      .map((item) => (
        <CommandItem
          key={item.id}
          value={item.id}
          disabled={item.disabled}
          onClick={() => select(item.run)}
          className={ROW_CLASS}
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
        value={item.id}
        onClick={() => select(() => props.onSelectSkill(item))}
        className={ROW_CLASS}
      >
        <SparklesIcon />
        <span className="min-w-0 flex-1 truncate">
          {item.label}
          <span className="ml-2 text-muted-foreground">{item.description}</span>
        </span>
      </CommandItem>
    ));

  const stashRows = props.stashEntries
    .filter((entry) => stashEntryMatchesQuery(entry, query))
    .map((entry) => (
      <CommandItem
        key={entry.id}
        value={entry.id}
        disabled={props.stashRestoreDisabled || Boolean(entry.pendingImageCount)}
        onClick={() => select(() => props.onRestoreStash(entry))}
        className={cn(ROW_CLASS, "group/stash")}
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
          className="-mr-1 shrink-0 rounded-full opacity-0 group-hover/stash:opacity-100 group-data-highlighted/stash:opacity-100 focus-visible:opacity-100"
          aria-label="Delete stashed prompt"
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            props.onDeleteStash(entry);
          }}
        >
          <XIcon />
        </Button>
      </CommandItem>
    ));

  return (
    <div
      ref={panelRef}
      id="composer-add-menu"
      role="dialog"
      aria-label="Add to message"
      data-composer-add-menu="true"
      style={
        maxHeight === null
          ? undefined
          : ({ "--add-menu-max-height": `${maxHeight}px` } as CSSProperties)
      }
      className="chat-composer-attached-panel absolute -inset-x-px bottom-[calc(100%+1px)] z-20 max-h-(--add-menu-max-height) overflow-hidden rounded-t-[22px] border border-b-0 border-border/60 shadow-[0_-12px_28px_-20px_rgb(0_0_0/0.35)]"
      onKeyDown={(event) => {
        // The panel lives inside the composer form; Enter must never submit the prompt.
        if (event.key === "Enter") event.preventDefault();
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (view === "main") props.onClose(true);
        else changeView("main");
      }}
    >
      <Command
        key={view}
        mode="none"
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          if (view === "paths") props.onPathQueryChange(value);
        }}
      >
        <div className="flex items-center gap-1 px-1.5 pt-1.5">
          {view !== "main" ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-1 shrink-0 rounded-full"
              aria-label="Back"
              onClick={() => changeView("main")}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}
          <CommandInput
            aria-label="Search the add menu"
            size="sm"
            placeholder={
              view === "paths"
                ? "Search project files and folders"
                : view === "stash"
                  ? "Search stashed prompts"
                  : "Search"
            }
            wrapperClassName="min-w-0 flex-1 px-0 py-0"
          />
        </div>
        <CommandList className="max-h-[calc(var(--add-menu-max-height,26rem)-2.75rem)] overflow-y-auto overscroll-contain not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
          {view === "main" ? (
            <>
              <CommandGroup>
                <CommandGroupLabel className={GROUP_LABEL_CLASS}>Add</CommandGroupLabel>
                {matches("Files and folders", "attach upload project") ? (
                  <CommandItem
                    value="attachments"
                    disabled={props.attachmentDisabled}
                    className={ROW_CLASS}
                    onClick={() => changeView("attachments")}
                  >
                    <PaperclipIcon />
                    <span className="flex-1">Files and folders</span>
                    <ChevronRightIcon />
                  </CommandItem>
                ) : null}
                {actionRows(props.actions)}
                {matches("Stash prompts", "save draft later restore") ? (
                  <CommandItem
                    value="stash"
                    className={ROW_CLASS}
                    onClick={() => changeView("stash")}
                  >
                    <BookmarkIcon />
                    <span className="flex-1">Stash prompts</span>
                    {props.stashEntries.length > 0 ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {props.stashEntries.length}
                      </span>
                    ) : null}
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
                    {query.trim()
                      ? "No matching skills."
                      : "No skills available for this provider and project."}
                  </p>
                ) : null}
              </CommandGroup>
            </>
          ) : view === "attachments" ? (
            <CommandGroup>
              <CommandGroupLabel className={GROUP_LABEL_CLASS}>Files and folders</CommandGroupLabel>
              <CommandItem
                value="upload-files"
                className={ROW_CLASS}
                onClick={() => select(props.onAttachFiles)}
              >
                <PaperclipIcon />
                <span className="flex-1">
                  Upload files
                  <span className="ml-2 text-muted-foreground">From this device</span>
                </span>
              </CommandItem>
              <CommandItem
                value="project-path"
                disabled={!props.canBrowsePaths}
                className={ROW_CLASS}
                onClick={() => changeView("paths")}
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
              <CommandGroupLabel className={GROUP_LABEL_CLASS}>Stashed prompts</CommandGroupLabel>
              {matches("Stash current prompt", "save draft") ? (
                <CommandItem
                  value="stash-current"
                  disabled={props.stashDisabled}
                  className={ROW_CLASS}
                  onClick={() => select(props.onStash)}
                >
                  <BookmarkPlusIcon />
                  <span className="flex-1">Stash current prompt</span>
                  {props.stashShortcut ? (
                    <CommandShortcut>{props.stashShortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ) : null}
              {stashRows}
              {props.stashEntries.length === 0 ? (
                <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                  Nothing stashed yet. Stashed prompts can be restored into any thread.
                </p>
              ) : stashRows.length === 0 ? (
                <p role="status" className="px-2.5 py-1.5 text-sm text-muted-foreground">
                  No matching stashed prompts.
                </p>
              ) : null}
            </CommandGroup>
          ) : (
            <CommandGroup>
              <CommandGroupLabel className={GROUP_LABEL_CLASS}>
                Project files and folders
              </CommandGroupLabel>
              {props.paths.map((entry) => (
                <CommandItem
                  key={`${entry.kind}:${entry.path}`}
                  value={entry.path}
                  className={ROW_CLASS}
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
                    : (props.pathsError ?? "No matching files or folders.")}
                </p>
              ) : null}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
