import * as Schema from "effect/Schema";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileArchiveIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  Grid2X2Icon,
  ListIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useProjectEntriesQuery, useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import {
  fileManagerBreadcrumbs,
  formatFileSize,
  listFileManagerItems,
  parentDirectory,
  type FileManagerItem,
} from "./workspaceFiles.logic";

const SELECTED_FILES_PROJECT_KEY = "pathway:files:selected-project";
const FILE_MANAGER_RENDER_LIMIT = 500;

function fileKind(path: string) {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(extension)) return "image";
  if (["zip", "gz", "tgz", "rar", "7z", "dmg"].includes(extension)) return "archive";
  if (["md", "mdx", "txt", "pdf", "doc", "docx", "rtf"].includes(extension)) return "document";
  if (extension) return "code";
  return "file";
}

function FileTypeIcon({ item, className }: { item: FileManagerItem; className?: string }) {
  if (item.kind === "directory")
    return (
      <FolderIcon
        className={cn("fill-amber-400/30 text-amber-600 dark:text-amber-400", className)}
      />
    );
  const kind = fileKind(item.path);
  if (kind === "image")
    return <FileImageIcon className={cn("text-fuchsia-600 dark:text-fuchsia-400", className)} />;
  if (kind === "archive")
    return <FileArchiveIcon className={cn("text-amber-700 dark:text-amber-400", className)} />;
  if (kind === "document")
    return <FileTextIcon className={cn("text-blue-600 dark:text-blue-400", className)} />;
  if (kind === "code")
    return <FileCode2Icon className={cn("text-emerald-600 dark:text-emerald-400", className)} />;
  return <FileIcon className={cn("text-muted-foreground", className)} />;
}

function FilePreview({
  environmentId,
  cwd,
  path,
  onClose,
}: {
  environmentId: Parameters<typeof useProjectFileQuery>[0];
  cwd: string;
  path: string;
  onClose: () => void;
}) {
  const file = useProjectFileQuery(environmentId, cwd, path);
  const kind = fileKind(path);
  const name = path.split("/").at(-1) ?? path;
  return (
    <aside className="flex min-h-0 w-full flex-col bg-background lg:w-[min(42%,36rem)] lg:shrink-0 lg:border-l lg:border-border/70 max-lg:absolute max-lg:inset-0 max-lg:z-20">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Button
          size="icon-sm"
          variant="ghost"
          className="lg:hidden"
          aria-label="Back to files"
          onClick={onClose}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>
          {name}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy relative path"
          onClick={() => void writeTextToClipboard(path)}
        >
          <CopyIcon />
        </Button>
      </div>
      {file.isPending && file.data === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : file.error && file.data === null ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
          {file.error}
        </div>
      ) : file.data ? (
        <>
          <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
            <span>{formatFileSize(file.data.byteLength)}</span>
            <span aria-hidden>·</span>
            <span className="capitalize">{kind}</span>
            {file.data.truncated ? (
              <span className="ml-auto text-warning-foreground">Preview truncated</span>
            ) : null}
          </div>
          {kind === "image" || kind === "archive" || path.toLocaleLowerCase().endsWith(".pdf") ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileIcon />
                </EmptyMedia>
                <EmptyTitle>Preview unavailable</EmptyTitle>
                <EmptyDescription>
                  Copy the path to open this file with a local tool.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea className="min-h-0 flex-1 bg-code-background">
              <pre className="min-w-max p-5 font-mono text-xs leading-5 text-code-foreground">
                <code>{file.data.contents}</code>
              </pre>
            </ScrollArea>
          )}
        </>
      ) : null}
    </aside>
  );
}

export function FilesView() {
  const projects = useProjects().filter(
    (project): project is typeof project & { workspaceRoot: string } =>
      project.workspaceRoot !== null,
  );
  const [storedProjectKey, setStoredProjectKey] = useLocalStorage(
    SELECTED_FILES_PROJECT_KEY,
    "",
    Schema.String,
  );
  const selectedProject =
    projects.find(({ environmentId, id }) => `${environmentId}:${id}` === storedProjectKey) ??
    projects[0] ??
    null;
  const selectedProjectKey = selectedProject
    ? `${selectedProject.environmentId}:${selectedProject.id}`
    : "";
  const [directory, setDirectory] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"list" | "grid">("list");

  useEffect(() => {
    setDirectory("");
    setSelectedPath(null);
    setQuery("");
  }, [selectedProjectKey]);

  if (!selectedProject) {
    return (
      <WorkspaceViewFrame title="Files">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No project files yet</EmptyTitle>
            <EmptyDescription>
              Add a project with a local folder, then return here to browse it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspaceViewFrame>
    );
  }

  return (
    <ProjectFilesBrowser
      key={selectedProjectKey}
      projects={projects}
      project={selectedProject}
      directory={directory}
      layout={layout}
      query={query}
      selectedPath={selectedPath}
      onDirectoryChange={(path) => {
        setDirectory(path);
        setSelectedPath(null);
        setQuery("");
      }}
      onLayoutChange={setLayout}
      onProjectChange={setStoredProjectKey}
      onQueryChange={setQuery}
      onSelectedPathChange={setSelectedPath}
    />
  );
}

function ProjectFilesBrowser({
  projects,
  project,
  directory,
  layout,
  query,
  selectedPath,
  onDirectoryChange,
  onLayoutChange,
  onProjectChange,
  onQueryChange,
  onSelectedPathChange,
}: {
  projects: ReturnType<typeof useProjects>;
  project: ReturnType<typeof useProjects>[number] & { workspaceRoot: string };
  directory: string;
  layout: "list" | "grid";
  query: string;
  selectedPath: string | null;
  onDirectoryChange: (path: string) => void;
  onLayoutChange: (layout: "list" | "grid") => void;
  onProjectChange: (key: string) => void;
  onQueryChange: (query: string) => void;
  onSelectedPathChange: (path: string | null) => void;
}) {
  const entriesQuery = useProjectEntriesQuery(project.environmentId, project.workspaceRoot);
  const deferredQuery = useDeferredValue(query);
  const allItems = useMemo(
    () => listFileManagerItems(entriesQuery.data?.entries ?? [], directory, deferredQuery),
    [deferredQuery, directory, entriesQuery.data?.entries],
  );
  const items = allItems.slice(0, FILE_MANAGER_RENDER_LIMIT);
  const breadcrumbs = fileManagerBreadcrumbs(directory);

  const openItem = (item: FileManagerItem) => {
    if (item.kind === "directory") onDirectoryChange(item.path);
    else onSelectedPathChange(item.path);
  };

  return (
    <WorkspaceViewFrame
      title="Files"
      actions={
        <select
          aria-label="Project files"
          value={`${project.environmentId}:${project.id}`}
          onChange={(event) => onProjectChange(event.target.value)}
          className="h-8 max-w-48 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {projects
            .filter(({ workspaceRoot }) => workspaceRoot !== null)
            .map((candidate) => (
              <option
                key={`${candidate.environmentId}:${candidate.id}`}
                value={`${candidate.environmentId}:${candidate.id}`}
              >
                {candidate.title}
              </option>
            ))}
        </select>
      }
    >
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2 sm:px-4">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Go to parent folder"
              disabled={!directory || Boolean(query)}
              onClick={() => onDirectoryChange(parentDirectory(directory))}
            >
              <ChevronLeftIcon />
            </Button>
            <nav
              aria-label="File location"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
            >
              {breadcrumbs.map((breadcrumb, index) => (
                <span key={breadcrumb.path || "root"} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? (
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <button
                    type="button"
                    className="max-w-40 cursor-pointer truncate rounded px-1.5 py-1 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onDirectoryChange(breadcrumb.path)}
                  >
                    {breadcrumb.label}
                  </button>
                </span>
              ))}
            </nav>
            <div className="relative w-full sm:w-56">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                type="search"
                aria-label="Search project files"
                placeholder="Search this project"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                className="pl-8"
              />
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh files"
              onClick={entriesQuery.refresh}
            >
              <RefreshCwIcon className={cn(entriesQuery.isPending && "animate-spin")} />
            </Button>
            <div className="flex rounded-lg border border-input p-0.5">
              <Button
                size="icon-xs"
                variant={layout === "list" ? "secondary" : "ghost"}
                aria-label="List view"
                aria-pressed={layout === "list"}
                onClick={() => onLayoutChange("list")}
              >
                <ListIcon />
              </Button>
              <Button
                size="icon-xs"
                variant={layout === "grid" ? "secondary" : "ghost"}
                aria-label="Grid view"
                aria-pressed={layout === "grid"}
                onClick={() => onLayoutChange("grid")}
              >
                <Grid2X2Icon />
              </Button>
            </div>
          </div>

          {entriesQuery.isPending && entriesQuery.data === null ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : entriesQuery.error && entriesQuery.data === null ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
              {entriesQuery.error}
            </div>
          ) : items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpenIcon />
                </EmptyMedia>
                <EmptyTitle>{query ? "No matching files" : "This folder is empty"}</EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "Try a filename or a different part of the path."
                    : "Files added to this folder will appear here after a refresh."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              {layout === "list" ? (
                <div className="min-w-[32rem]">
                  <div className="grid grid-cols-[minmax(0,1fr)_8rem] border-b border-border/70 px-5 py-2 text-[11px] font-medium text-muted-foreground">
                    <span>Name</span>
                    <span>Type</span>
                  </div>
                  <div className="divide-y divide-border/60">
                    {items.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className={cn(
                          "grid min-h-11 w-full cursor-pointer grid-cols-[minmax(0,1fr)_8rem] items-center px-5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          selectedPath === item.path && "bg-accent",
                        )}
                        onDoubleClick={() => openItem(item)}
                        onClick={() =>
                          item.kind === "file" ? onSelectedPathChange(item.path) : openItem(item)
                        }
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <FileTypeIcon item={item} className="size-5 shrink-0" />
                          <span className="truncate text-sm font-medium">{item.name}</span>
                        </span>
                        <span className="text-xs text-muted-foreground capitalize">
                          {item.kind === "directory" ? "Folder" : fileKind(item.path)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 p-4">
                  {items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className={cn(
                        "flex min-h-32 cursor-pointer flex-col items-start justify-between rounded-xl border border-transparent p-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                        selectedPath === item.path && "border-border bg-accent",
                      )}
                      onDoubleClick={() => openItem(item)}
                      onClick={() =>
                        item.kind === "file" ? onSelectedPathChange(item.path) : openItem(item)
                      }
                    >
                      <FileTypeIcon item={item} className="size-8" />
                      <span className="w-full truncate text-sm font-medium">{item.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}
          <footer className="flex min-h-8 items-center border-t border-border/70 px-4 text-[11px] text-muted-foreground">
            {allItems.length > items.length
              ? `First ${items.length} of ${allItems.length} items`
              : `${items.length} ${items.length === 1 ? "item" : "items"}`}
            {entriesQuery.data?.truncated ? " · listing truncated" : ""}
          </footer>
        </main>
        {selectedPath ? (
          <FilePreview
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            path={selectedPath}
            onClose={() => onSelectedPathChange(null)}
          />
        ) : null}
      </div>
    </WorkspaceViewFrame>
  );
}
