import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { Globe2Icon, MessagesSquareIcon } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useProjects, useThreadShells } from "~/state/entities";
import { useActivePreviewSessions } from "~/previewStateStore";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { PreviewPanel } from "../preview/PreviewPanel";
import { getConfiguredPreviewUrls } from "../preview/previewEmptyStateLogic";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { browserThreadOptions, resolveBrowserThreadOption } from "./browserView.logic";

const BROWSER_THREAD_STORAGE_KEY = "pathway:browser:selected-thread";

export function BrowserView() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const previewSessions = useActivePreviewSessions();
  const [preferredThreadKey, setPreferredThreadKey] = useLocalStorage(
    BROWSER_THREAD_STORAGE_KEY,
    "",
    Schema.String,
  );
  const projectTitles = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
        ),
      ),
    [projects],
  );
  const options = useMemo(
    () => browserThreadOptions(threads, new Set(Object.keys(previewSessions))),
    [previewSessions, threads],
  );
  const selected = resolveBrowserThreadOption(options, preferredThreadKey);
  const selectedProject = selected
    ? (projects.find(
        (project) =>
          project.environmentId === selected.environmentId && project.id === selected.projectId,
      ) ?? null)
    : null;

  if (selected === null) {
    return (
      <WorkspaceViewFrame title="Browser">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Globe2Icon />
            </EmptyMedia>
            <EmptyTitle>No thread to browse from</EmptyTitle>
            <EmptyDescription>
              Create a thread first. Browser sessions stay attached to their thread so agents and
              remote environments share the same context.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkspaceViewFrame>
    );
  }

  const threadRef = scopeThreadRef(selected.environmentId, selected.threadId);
  const configuredUrls = getConfiguredPreviewUrls(selectedProject?.scripts);

  return (
    <WorkspaceViewFrame
      title="Browser"
      actions={
        <>
          <label className="sr-only" htmlFor="browser-thread">
            Browser thread
          </label>
          <select
            id="browser-thread"
            value={selected.key}
            onChange={(event) => setPreferredThreadKey(event.target.value)}
            className="h-8 max-w-[min(48vw,22rem)] rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {options.map((option) => {
              const projectTitle =
                projectTitles.get(`${option.environmentId}:${option.projectId}`) ?? "Project";
              return (
                <option key={option.key} value={option.key}>
                  {option.hasOpenBrowser ? "● " : ""}
                  {projectTitle} · {option.title}
                </option>
              );
            })}
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Open thread ${selected.title}`}
            onClick={() =>
              void navigate({
                to: "/threads/$environmentId/$threadId",
                params: {
                  environmentId: selected.environmentId,
                  threadId: selected.threadId,
                },
              })
            }
          >
            <MessagesSquareIcon />
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PreviewPanel
          key={selected.key}
          mode="embedded"
          threadRef={threadRef}
          configuredUrls={configuredUrls}
          visible
          allowInlinePictureInPicture={false}
        />
      </div>
    </WorkspaceViewFrame>
  );
}
