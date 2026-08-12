/**
 * The directory picker shared by the attach and quick-create dialogs.
 *
 * It is the same browse mechanism the add-project palette flow uses — `filesystem.browse` against
 * the *target* environment, driven by the client-runtime path helpers so `~/`, trailing separators
 * and hidden-file filtering behave identically — with the palette's command-list chrome swapped
 * for a text field and a scrolling list of child directories, because a dialog has no query line
 * to hijack.
 *
 * @module components/projects/ProjectDirectoryField
 */
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
  isExplicitRelativeProjectPath,
} from "@t3tools/client-runtime/state/projects";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId, FilesystemBrowseResult } from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { useMemo } from "react";

import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { Input } from "../ui/input";

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

/** The browser's own platform is the right default: a local server runs on this machine. */
export function environmentBrowsePlatform(os: string | null | undefined): string {
  if (os === "windows") return "Win32";
  if (os === "darwin") return "MacIntel";
  if (os === "linux") return "Linux";
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function ProjectDirectoryField({
  environmentId,
  platform,
  currentProjectCwd,
  value,
  onChange,
  autoFocus = false,
  disabled = false,
  inputLabel = "Project directory",
}: {
  environmentId: EnvironmentId | null;
  platform: string;
  currentProjectCwd: string | null;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  inputLabel?: string;
}) {
  const browsePath = useMemo(() => getFilesystemBrowsePath(value, platform), [platform, value]);
  // A relative path with nothing to resolve it against would make the server answer
  // `current_project_required`; not asking keeps the field quiet until it can succeed.
  const relativeNeedsAnchor = isExplicitRelativeProjectPath(value.trim()) && !currentProjectCwd;
  const browseQuery = useEnvironmentQuery(
    environmentId !== null &&
      browsePath.isBrowsing &&
      browsePath.directoryPath.length > 0 &&
      !relativeNeedsAnchor
      ? filesystemEnvironment.browse({
          environmentId,
          input: {
            partialPath: browsePath.directoryPath,
            ...(currentProjectCwd ? { cwd: currentProjectCwd } : {}),
          },
        })
      : null,
  );
  const entries = browseQuery.data?.entries ?? EMPTY_BROWSE_ENTRIES;
  const { visibleEntries } = useMemo(
    () => filterFilesystemBrowseEntries(entries, browsePath.filterQuery),
    [browsePath.filterQuery, entries],
  );
  const parentPath = browsePath.canBrowseUp ? getBrowseParentPath(browsePath.directoryPath) : null;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        aria-label={inputLabel}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="~/code/my-project"
        spellCheck={false}
        value={value}
      />
      <div className="max-h-48 min-h-0 overflow-y-auto rounded-md border border-border/60">
        {parentPath !== null ? (
          <DirectoryRow
            disabled={disabled}
            icon={<CornerLeftUpIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            label="Parent directory"
            onSelect={() => onChange(ensureBrowseDirectoryPath(parentPath))}
          />
        ) : null}
        {visibleEntries.map((entry) => (
          <DirectoryRow
            disabled={disabled}
            icon={<FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />}
            key={entry.fullPath}
            label={entry.name}
            onSelect={() =>
              onChange(
                ensureBrowseDirectoryPath(
                  appendBrowsePathSegment(browsePath.directoryPath, entry.name),
                ),
              )
            }
          />
        ))}
        {parentPath === null && visibleEntries.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {browseQuery.isPending
              ? "Loading…"
              : relativeNeedsAnchor
                ? "Relative paths need an active project."
                : browseQuery.error !== null
                  ? "That directory could not be read."
                  : "Type a path to browse."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DirectoryRow({
  disabled,
  icon,
  label,
  onSelect,
}: {
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent/60 disabled:opacity-50"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
