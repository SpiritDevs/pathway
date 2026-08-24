import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { threadIsVisibleAt } from "@spiritdevs/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { useWorkspaceProjects } from "../components/projects/useWorkspaceProjects";
import { workspaceThreadStartAvailability } from "../components/projects/workspaceProjects.logic";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

// #region DEBUG
function debugThreadsLanding(
  hypothesis: string,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis, event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <IndexDraftLanding />;
}

/**
 * Landing on the index route drops straight into a draft thread for the most
 * recently active project, so the first screen is a prompt instead of a dead
 * end. Falls back to an add-project hero when no project exists yet.
 */
function IndexDraftLanding() {
  const projects = useProjects();
  const workspaceProjects = useWorkspaceProjects();
  const threads = useThreadShells();
  const agentThreads = useMemo(
    () => threads.filter((thread) => threadIsVisibleAt(thread, "agents")),
    [threads],
  );
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();
  const startingRef = useRef(false);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });

  const mostRecentProject = useMemo(
    () =>
      bootstrapped
        ? (sortScopedProjectsForSidebar(projects, agentThreads, "updated_at")[0] ?? null)
        : null,
    [agentThreads, bootstrapped, projects],
  );

  useEffect(() => {
    // #region DEBUG
    debugThreadsLanding("H1/H2", "landing-state-observed", {
      bootstrapped,
      projectCount: projects.length,
      workspaceProjectCount: workspaceProjects.length,
      threadStartAvailability: workspaceThreadStartAvailability(workspaceProjects),
      threadCount: threads.length,
      agentThreadCount: agentThreads.length,
      hasMostRecentProject: mostRecentProject !== null,
      starting: startingRef.current,
      failed: startState.failed,
    });
    // #endregion DEBUG
  }, [
    agentThreads.length,
    bootstrapped,
    mostRecentProject,
    projects.length,
    startState.failed,
    threads.length,
    workspaceProjects,
  ]);

  useEffect(() => {
    if (mostRecentProject === null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    // #region DEBUG
    debugThreadsLanding("H3", "draft-start-requested", {
      projectCount: projects.length,
      bootstrapped,
    });
    // #endregion DEBUG
    void handleNewThread(scopeProjectRef(mostRecentProject.environmentId, mostRecentProject.id), {
      replace: true,
    })
      .then(() => {
        // #region DEBUG
        debugThreadsLanding("H3", "draft-start-resolved", {
          projectCount: projects.length,
        });
        // #endregion DEBUG
      })
      .catch(() => {
        // #region DEBUG
        debugThreadsLanding("H3", "draft-start-rejected", {
          projectCount: projects.length,
        });
        // #endregion DEBUG
        startingRef.current = false;
        setStartState((state) => ({ ...state, failed: true }));
      });
  }, [handleNewThread, mostRecentProject, startState.retryRequest]);

  if (!bootstrapped) {
    return null;
  }
  if (mostRecentProject !== null) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  return <NoProjectsHero availability={workspaceThreadStartAvailability(workspaceProjects)} />;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle className="text-foreground text-xl">Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

function NoProjectsHero({
  availability,
}: {
  readonly availability: ReturnType<typeof workspaceThreadStartAvailability>;
}) {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const openNewThread = useCallback(() => openCommandPalette({ open: "new-thread-in" }), []);
  const hasWorkspaceProjects = availability !== "unavailable";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl sm:text-3xl">
                What should we work on?
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {availability === "needs-checkout"
                  ? "Choose a project to create its checkout and start your first thread."
                  : hasWorkspaceProjects
                    ? "Choose a project to start your first thread."
                    : "Add a project to start your first thread."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={hasWorkspaceProjects ? openNewThread : openAddProject}>
                  <PlusIcon className="size-4" />
                  {hasWorkspaceProjects ? "New thread" : "Add project"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/threads")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "workspace-topbar border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to Pathway Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/environments" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Environments" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
